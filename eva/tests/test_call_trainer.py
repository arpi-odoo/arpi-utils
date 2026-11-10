import io
import json
from unittest.mock import patch

from odoo.exceptions import AccessError, UserError
from odoo.tests import HttpCase, new_test_user, tagged, TransactionCase
from odoo.tools import BinaryBytes

from odoo.addons.bus.tests.common import WebsocketCase
from odoo.addons.eva.models.eva_map_call import normalize_call, typo_distance


def _image():
    from PIL import Image
    buffer = io.BytesIO()
    Image.new('RGB', (4, 4), 'red').save(buffer, 'PNG')
    return BinaryBytes(buffer.getvalue())


@tagged('post_install', '-at_install')
class TestCallTrainer(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.user_a = new_test_user(cls.env, 'eva_ct_a', groups='base.group_user')
        cls.user_b = new_test_user(cls.env, 'eva_ct_b', groups='base.group_user')
        cls.map = cls.env['eva.map'].create({'name': 'Test Map'})
        image = _image()
        cls.calls = cls.env['eva.map.call'].create([{
            'map_id': cls.map.id,
            'name': name,
            'aliases': aliases,
            'image_ids': [(0, 0, {'image': image}), (0, 0, {'image': image})],
        } for name, aliases in [('Box', False), ('Bot', False), ('Mid Door', 'Middle Door, MD'), ('Top', False)]])
        cls.box, cls.bot, cls.mid_door, cls.top = cls.calls

    def test_normalize_and_distance(self):
        self.assertEqual(normalize_call(' Mid-Dóor '), 'middoor')
        self.assertEqual(typo_distance('top', 'tpo'), 1)
        self.assertEqual(typo_distance('middoor', 'midor'), 2)

    def test_answer_matching(self):
        self.assertTrue(self.mid_door._is_answer_correct('mid door'))
        self.assertTrue(self.mid_door._is_answer_correct('MIDDOOR'))
        self.assertTrue(self.mid_door._is_answer_correct('mid dor'))
        self.assertTrue(self.mid_door._is_answer_correct('midle door'))
        self.assertTrue(self.mid_door._is_answer_correct('md'))
        self.assertFalse(self.mid_door._is_answer_correct('m'))
        self.assertFalse(self.mid_door._is_answer_correct('top'))
        self.assertTrue(self.top._is_answer_correct('Tpo'))
        self.assertTrue(self.box._is_answer_correct('box'))
        # "Bot" is exactly another call; "bix" is 1 away from "box" but 2 from
        # "bot", so it's a typo of Box.
        self.assertFalse(self.box._is_answer_correct('bot'))
        self.assertTrue(self.box._is_answer_correct('bix'))
        # "Bo" is one deletion away from both "Box" and "Bot": ambiguous.
        self.assertFalse(self.box._is_answer_correct('bo'))
        self.assertFalse(self.box._is_answer_correct(''))

    def test_solo_flow(self):
        Training = self.env['eva.call.training'].with_user(self.user_a)
        training = Training.browse(Training.create_training(self.map.id, 6, 1, 10, solo=True))
        self.assertEqual(training.state, 'running')
        self.assertEqual(len(training.sudo().round_ids), 6)
        # Every call is drawn once before any is drawn twice.
        first_calls = training.sudo().round_ids.sorted('sequence')[:4].call_id
        self.assertEqual(len(first_calls), 4)

        participant = training.participant_ids
        rounds = training.sudo().round_ids.sorted('sequence')
        round_data = participant.get_current_round()
        self.assertEqual(round_data['round_number'], 1)
        # Asking again doesn't restart the round.
        self.assertEqual(participant.get_current_round()['round_number'], 1)

        result = participant.submit_answer(1, rounds[0].call_id.name.lower())
        self.assertEqual(result['result'], 'correct')
        self.assertGreaterEqual(result['points'], 100)
        # Double submission of the same round is ignored.
        self.assertFalse(participant.submit_answer(1, 'whatever'))

        participant.get_current_round()
        self.assertEqual(participant.submit_answer(2, 'nope')['result'], 'wrong')
        self.assertEqual(participant.lives_left, 0)
        participant.get_current_round()
        result = participant.submit_answer(3, '')
        self.assertEqual(result['result'], 'timeout')
        self.assertTrue(result['finished'])
        self.assertEqual(participant.state, 'finished')
        self.assertEqual(training.state, 'done')
        self.assertEqual(participant.correct_count, 1)
        self.assertAlmostEqual(participant.accuracy, 100 / 6)
        self.assertEqual(len(training.get_trainer_state()['me']['answers']), 3)

    def test_multiplayer_flow(self):
        training_a = self.env['eva.call.training'].with_user(self.user_a).browse(
            self.env['eva.call.training'].with_user(self.user_a).create_training(self.map.id, 2, 0, 10))
        training_b = training_a.with_user(self.user_b)
        self.assertEqual(training_a.state, 'lobby')
        with self.assertRaises(UserError):
            training_b.action_start()
        training_b.action_join()
        self.assertEqual(len(training_a.participant_ids), 2)
        training_a.action_start()
        self.assertEqual(training_a.state, 'running')
        # Upcoming calls can't be peeked at.
        with self.assertRaises(AccessError):
            self.env['eva.call.training.round'].with_user(self.user_b).search_read(
                [('training_id', '=', training_a.id)], ['call_id'])

        participant_a = training_a.participant_ids.filtered(lambda p: p.user_id == self.user_a)
        participant_b = training_b.participant_ids.filtered(lambda p: p.user_id == self.user_b)
        with self.assertRaises(UserError):
            participant_a.with_user(self.user_b).get_current_round()

        rounds = training_a.sudo().round_ids.sorted('sequence')
        for number, call_round in enumerate(rounds, 1):
            participant_a.with_user(self.user_a).get_current_round()
            participant_a.with_user(self.user_a).submit_answer(number, call_round.call_id.name)
        self.assertEqual(participant_a.state, 'finished')
        self.assertEqual(training_a.state, 'running')

        # Sudden death for B.
        participant_b.with_user(self.user_b).get_current_round()
        participant_b.with_user(self.user_b).submit_answer(1, 'nope')
        self.assertEqual(participant_b.state, 'finished')
        self.assertEqual(training_a.state, 'done')

        state = training_a.get_trainer_state()
        self.assertEqual([p['user_id'] for p in state['participants']], [self.user_a.id, self.user_b.id])
        self.assertEqual([p['rank'] for p in state['participants']], [1, 2])

        # Rematch: the first one creates a lobby, the second one joins it.
        rematch_id = training_a.action_rematch()
        self.assertEqual(training_b.action_rematch(), rematch_id)
        self.assertEqual(len(self.env['eva.call.training'].browse(rematch_id).participant_ids), 2)

    def test_leave_lobby(self):
        Training = self.env['eva.call.training'].with_user(self.user_a)
        training = Training.browse(Training.create_training(self.map.id, 3, 1, 10))
        training.with_user(self.user_b).action_join()
        training.action_leave()
        self.assertEqual(training.host_id, self.user_b)
        training.with_user(self.user_b).action_leave()
        self.assertFalse(training.exists())

    def test_one_lobby_at_a_time(self):
        Training = self.env['eva.call.training'].with_user(self.user_a)
        old = Training.browse(Training.create_training(self.map.id, 3, 1, 10))
        new = Training.browse(Training.create_training(self.map.id, 3, 1, 10))
        # A's first lobby, which only had A, is gone.
        self.assertFalse(old.exists())
        other = Training.with_user(self.user_b).browse(
            Training.with_user(self.user_b).create_training(self.map.id, 3, 1, 10))
        other.with_user(self.user_a).action_join()
        # Joining B's lobby leaves A's own one.
        self.assertFalse(new.exists())
        self.assertEqual(other.participant_ids.user_id, self.user_a | self.user_b)

    def test_lobbies_notification(self):
        Training = self.env['eva.call.training'].with_user(self.user_a)
        with patch.object(type(self.env['bus.bus']), '_sendone', autospec=True) as sendone:
            Training.create_training(self.map.id, 3, 1, 10)
        sendone.assert_called_once_with(
            self.env['bus.bus'], self.map, 'eva.call.training/lobbies_updated', {'map_id': self.map.id})

    def test_abandoned_player(self):
        Training = self.env['eva.call.training'].with_user(self.user_a)
        training = Training.browse(Training.create_training(self.map.id, 3, 1, 10))
        training.with_user(self.user_b).action_join()
        training.action_start()
        participant_a = training.participant_ids.filtered(lambda p: p.user_id == self.user_a)
        participant_b = training.participant_ids.filtered(lambda p: p.user_id == self.user_b)
        participant_a.get_current_round()
        # B is still within the time limit: not considered gone yet.
        training.get_trainer_state()
        self.assertEqual(participant_b.state, 'playing')
        # B closed the tab a while ago.
        participant_b.sudo().last_activity -= 1000
        participant_a.sudo().last_activity -= 1000
        training.get_trainer_state()
        self.assertEqual(participant_b.state, 'finished')
        self.assertEqual(training.state, 'done')


@tagged('post_install', '-at_install')
class TestCallTrainerTour(HttpCase):

    def test_solo_tour(self):
        game_map = self.env['eva.map'].create({'name': 'Tour Map'})
        self.env['eva.map.call'].create({
            'map_id': game_map.id,
            'name': 'Box',
            'image_ids': [(0, 0, {'image': _image()})],
        })
        self.start_tour(f'/odoo/action-eva.action_eva_map/{game_map.id}', 'eva_call_trainer_solo', login='admin')


@tagged('post_install', '-at_install')
class TestCallTrainerBus(WebsocketCase):

    def test_lobby_notifications(self):
        user_a = new_test_user(self.env, 'eva_ws_a', groups='base.group_user', password='eva_ws_a_pwd')
        user_b = new_test_user(self.env, 'eva_ws_b', groups='base.group_user')
        game_map = self.env['eva.map'].create({'name': 'WS Map'})
        self.env['eva.map.call'].create({
            'map_id': game_map.id, 'name': 'Box', 'image_ids': [(0, 0, {'image': _image()})],
        })
        Training = self.env['eva.call.training'].with_user(user_a)
        training = Training.browse(Training.create_training(game_map.id, 3, 1, 10))
        self.trigger_notification_dispatching()

        session = self.authenticate('eva_ws_a', 'eva_ws_a_pwd')
        ws = self.websocket_connect(cookie=f'session_id={session.sid}')
        home_channel = Training.get_trainer_home(game_map.id)['channel']
        self.subscribe(ws, [training._bus_channel_name(), home_channel], self.env['bus.bus']._bus_last_id())
        training.with_user(user_b).action_join()
        self.trigger_notification_dispatching()
        # One frame per channel.
        notifications = json.loads(ws.recv()) + json.loads(ws.recv())
        self.assertEqual(
            sorted((n['message']['type'], n['message']['payload']) for n in notifications),
            [
                ('eva.call.training/lobbies_updated', {'map_id': game_map.id}),
                ('eva.call.training/updated', {'training_id': training.id}),
            ],
        )

