import random
import time

from odoo import api, fields, models
from odoo.exceptions import UserError, ValidationError
from odoo.tools import SQL

# Tolerance on the per-round time limit, to absorb network latency between the
# moment the player hits Enter and the moment the server receives the answer.
ANSWER_GRACE_SECONDS = 1.5
CORRECT_POINTS = 100
SPEED_BONUS_POINTS = 50
# A player who shows no sign of life for this long past the end of their
# current round (closed tab, lost connection...) is considered gone, and their
# training ends with what they scored so far, so that the others' doesn't
# wait for them forever.
ABANDON_SECONDS = 60


class EvaCallTraining(models.Model):
    """A Call Trainer session: a fixed sequence of (call, image) rounds on a
    map, played by one or several users. Every participant gets the very same
    rounds in the same order, at their own pace, and scores are compared at the
    end. All mutations go through the action methods below (users only have
    read access), which check who is allowed to do what."""
    _name = 'eva.call.training'
    _description = 'EVA Call Training'
    _inherit = ['bus.listener.mixin']
    _order = 'create_date desc, id desc'

    name = fields.Char(compute='_compute_name')
    map_id = fields.Many2one('eva.map', required=True, index=True, ondelete='cascade')
    host_id = fields.Many2one('res.users', required=True, default=lambda self: self.env.user, ondelete='cascade')
    state = fields.Selection([
        ('lobby', 'Lobby'),
        ('running', 'In Progress'),
        ('done', 'Finished'),
    ], required=True, default='lobby', index=True)
    round_count = fields.Integer('Rounds', required=True, default=10)
    lives = fields.Integer('Allowed Mistakes', required=True, default=3)
    time_per_round = fields.Integer('Seconds per Round', required=True, default=10)
    start_date = fields.Datetime(readonly=True)
    end_date = fields.Datetime(readonly=True)
    round_ids = fields.One2many('eva.call.training.round', 'training_id')
    participant_ids = fields.One2many('eva.call.training.participant', 'training_id', string='Participants')
    participant_count = fields.Integer(compute='_compute_participant_count')
    rematch_id = fields.Many2one('eva.call.training', readonly=True, ondelete='set null',
                                 help='Training created from this one with the same settings.')

    @api.constrains('round_count', 'lives', 'time_per_round')
    def _check_settings(self):
        for training in self:
            if not 1 <= training.round_count <= 100:
                raise ValidationError(self.env._('A training must have between 1 and 100 rounds.'))
            if training.lives < 0:
                raise ValidationError(self.env._('The number of allowed mistakes cannot be negative.'))
            if not 3 <= training.time_per_round <= 120:
                raise ValidationError(self.env._('The time per round must be between 3 and 120 seconds.'))

    @api.depends('map_id', 'create_date', 'host_id')
    def _compute_name(self):
        for training in self:
            date = fields.Datetime.context_timestamp(training, training.create_date) if training.create_date else False
            training.name = self.env._(
                '%(map)s calls by %(host)s%(date)s',
                map=training.map_id.name,
                host=training.host_id.name,
                date=f' ({date:%Y-%m-%d %H:%M})' if date else '',
            )

    @api.depends('participant_ids')
    def _compute_participant_count(self):
        for training in self:
            training.participant_count = len(training.participant_ids)

    # ------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------

    def _bus_channel_name(self):
        return f'eva.call.training_{self.id}'

    def _notify_update(self):
        for training in self:
            training._bus_send('eva.call.training/updated', {'training_id': training.id})

    def _get_my_participant(self):
        self.ensure_one()
        return self.participant_ids.filtered(lambda p: p.user_id == self.env.user)[:1]

    @api.model
    def _get_playable_calls(self, map_id):
        return self.env['eva.map.call'].search([('map_id', '=', map_id), ('image_ids', '!=', False)])

    def _generate_rounds(self):
        """Draw a random call for each round, with a random image of it.

        Calls are drawn from a shuffled deck so that every call shows up once
        before any shows up twice, and the deck is reshuffled when exhausted
        (never starting with the call that just ended the previous deck).
        Images of a given call are likewise not repeated until all were used."""
        self.ensure_one()
        calls = self._get_playable_calls(self.map_id.id)
        if not calls:
            raise UserError(self.env._('There are no calls with images on %s yet.', self.map_id.name))

        deck = []
        unused_images = {}
        last_call = None
        rounds = []
        for sequence in range(self.round_count):
            if not deck:
                deck = list(calls)
                random.shuffle(deck)
                if len(deck) > 1 and deck[-1] == last_call:
                    deck[0], deck[-1] = deck[-1], deck[0]
            call = deck.pop()
            if not unused_images.get(call.id):
                unused_images[call.id] = list(call.image_ids)
                random.shuffle(unused_images[call.id])
            image = unused_images[call.id].pop()
            rounds.append({'training_id': self.id, 'sequence': sequence, 'call_id': call.id, 'image_id': image.id})
            last_call = call
        self.env['eva.call.training.round'].sudo().create(rounds)

    def _touch(self):
        """Update the training row, so that concurrent requests changing who
        takes part or who's done (join vs start, two players finishing at the
        same time) conflict on it and get retried, instead of each deciding on
        a stale view of the participants."""
        self.env.cr.execute(SQL(
            'UPDATE eva_call_training SET write_date = NOW() AT TIME ZONE %s WHERE id IN %s',
            'UTC', tuple(self.ids),
        ))
        self.invalidate_recordset(['write_date'])

    def _finish_abandoned_participants(self):
        now = time.time()
        for training in self.filtered(lambda t: t.state == 'running'):
            gone = training.participant_ids.filtered(lambda p: (
                p.state == 'playing'
                and now - p.last_activity > training.time_per_round + ABANDON_SECONDS
            ))
            if gone:
                gone.sudo()._finish()
                training._notify_update()

    def _check_done(self):
        for training in self.filtered(lambda t: t.state == 'running'):
            if all(p.state == 'finished' for p in training.participant_ids):
                training.sudo().write({'state': 'done', 'end_date': fields.Datetime.now()})

    # ------------------------------------------------------------
    # Actions (called from the Call Trainer client action)
    # ------------------------------------------------------------

    @api.model
    def create_training(self, map_id, round_count, lives, time_per_round, solo=False):
        if not self._get_playable_calls(map_id):
            raise UserError(self.env._('There are no calls with images on this map yet.'))
        training = self.sudo().create({
            'map_id': map_id,
            'host_id': self.env.uid,
            'round_count': round_count,
            'lives': lives,
            'time_per_round': time_per_round,
        })
        self.env['eva.call.training.participant'].sudo().create({
            'training_id': training.id,
            'user_id': self.env.uid,
        })
        training = training.sudo(False)
        if solo:
            training.action_start()
        return training.id

    def action_join(self):
        self.ensure_one()
        if self._get_my_participant():
            return True
        if self.state != 'lobby':
            raise UserError(self.env._('This training has already started, you can no longer join it.'))
        self._touch()
        self.env['eva.call.training.participant'].sudo().create({
            'training_id': self.id,
            'user_id': self.env.uid,
        })
        self._notify_update()
        return True

    def action_leave(self):
        self.ensure_one()
        participant = self._get_my_participant()
        if not participant:
            return True
        if self.state == 'lobby':
            participant.sudo().unlink()
            remaining = self.participant_ids
            if not remaining:
                self.sudo().unlink()
                return True
            if self.host_id == self.env.user:
                self.sudo().host_id = remaining[0].user_id
        elif participant.state != 'finished':
            # Giving up mid-game: keep what was played so far as the score.
            participant.sudo()._finish()
        self._notify_update()
        return True

    def action_start(self):
        self.ensure_one()
        if self.host_id != self.env.user:
            raise UserError(self.env._('Only the host can start the training.'))
        if self.state != 'lobby':
            return True
        self._generate_rounds()
        self.sudo().write({'state': 'running', 'start_date': fields.Datetime.now()})
        self.participant_ids.sudo().write({'state': 'playing', 'last_activity': time.time()})
        self._notify_update()
        return True

    def action_rematch(self):
        """Play again with the same settings: the first player asking creates
        the new training (straight away for a solo training, as a lobby
        otherwise) and the others are offered to join it."""
        self.ensure_one()
        if self.rematch_id.state == 'lobby':
            self.rematch_id.action_join()
            return self.rematch_id.id
        solo = self.participant_count <= 1
        rematch_id = self.create_training(self.map_id.id, self.round_count, self.lives, self.time_per_round, solo=solo)
        if not solo:
            self.sudo().rematch_id = rematch_id
            self._notify_update()
        return rematch_id

    def get_trainer_state(self):
        self.ensure_one()
        self._finish_abandoned_participants()
        me = self._get_my_participant()
        participants = self.participant_ids.sorted(lambda p: (-p.score, p.avg_response_time or 0, p.id))
        ranks = participants._get_ranks()
        state = {
            'id': self.id,
            'name': self.name,
            'state': self.state,
            'map': {'id': self.map_id.id, 'name': self.map_id.name},
            'host': {'id': self.host_id.id, 'name': self.host_id.name},
            'is_host': self.host_id == self.env.user,
            'round_count': self.round_count,
            'lives': self.lives,
            'time_per_round': self.time_per_round,
            'channel': self._bus_channel_name(),
            'rematch_id': self.rematch_id.id if self.rematch_id.state == 'lobby' else False,
            'participants': [{
                'id': p.id,
                'user_id': p.user_id.id,
                'name': p.user_id.name,
                'is_me': p == me,
                'state': p.state,
                'score': p.score,
                'correct_count': p.correct_count,
                'mistake_count': p.mistake_count,
                'lives_left': p.lives_left,
                'answered_count': p.answered_count,
                'avg_response_time': p.avg_response_time,
                'rank': ranks[p.id],
            } for p in participants],
            'me': False,
        }
        if me:
            state['me'] = {
                'id': me.id,
                'state': me.state,
                'score': me.score,
                'lives_left': me.lives_left,
                'answered_count': me.answered_count,
                'rank': ranks[me.id],
            }
            if me.state == 'finished':
                state['me']['answers'] = [{
                    'round_number': answer.round_number,
                    'call': answer.call_id.name,
                    'answer': answer.answer or '',
                    'result': answer.result,
                    'points': answer.points,
                    'response_time': answer.response_time,
                    'image_url': me._get_image_url(answer.round_number),
                } for answer in me.answer_ids.sorted('round_number')]
        return state

    @api.model
    def get_trainer_home(self, map_id):
        """Data for the Call Trainer landing page of a map."""
        game_map = self.env['eva.map'].browse(map_id)
        calls = self._get_playable_calls(map_id)
        open_trainings = self.search([
            ('map_id', '=', map_id),
            '|', ('state', '=', 'lobby'),
            '&', ('state', '=', 'running'), ('participant_ids', 'any', [
                ('user_id', '=', self.env.uid), ('state', '!=', 'finished'),
            ]),
        ])
        my_results = self.env['eva.call.training.participant'].search([
            ('map_id', '=', map_id),
            ('user_id', '=', self.env.uid),
            ('state', '=', 'finished'),
        ], limit=10)
        best = self.env['eva.call.training.participant'].search([
            ('map_id', '=', map_id), ('user_id', '=', self.env.uid), ('state', '=', 'finished'),
        ], order='accuracy desc, score desc', limit=1)
        return {
            'map': {'id': game_map.id, 'name': game_map.name},
            'call_count': len(calls),
            'image_count': sum(calls.mapped('image_count')),
            'open_trainings': [{
                'id': training.id,
                'state': training.state,
                'host': training.host_id.name,
                'participant_names': training.participant_ids.user_id.mapped('name'),
                'is_mine': bool(training._get_my_participant()),
                'round_count': training.round_count,
                'lives': training.lives,
                'time_per_round': training.time_per_round,
            } for training in open_trainings],
            'my_results': [{
                'training_id': result.training_id.id,
                'date': fields.Datetime.to_string(result.date) if result.date else False,
                'score': result.score,
                'correct_count': result.correct_count,
                'round_count': result.training_id.round_count,
                'accuracy': result.accuracy,
                'participant_count': result.training_id.participant_count,
                'rank': result._get_ranks()[result.id] if result.training_id.participant_count > 1 else False,
            } for result in my_results],
            'best_accuracy': best.accuracy if best else False,
        }


class EvaCallTrainingRound(models.Model):
    """The pre-drawn rounds of a training. Not readable by regular users, so
    that upcoming calls can't be peeked at through RPC."""
    _name = 'eva.call.training.round'
    _description = 'EVA Call Training Round'
    _order = 'training_id, sequence'

    training_id = fields.Many2one('eva.call.training', required=True, index=True, ondelete='cascade')
    sequence = fields.Integer(required=True)
    call_id = fields.Many2one('eva.map.call', required=True, ondelete='cascade')
    image_id = fields.Many2one('eva.map.call.image', required=True, ondelete='cascade')


class EvaCallTrainingParticipant(models.Model):
    _name = 'eva.call.training.participant'
    _description = 'EVA Call Training Participant'
    _order = 'date desc, id desc'
    _rec_name = 'user_id'

    training_id = fields.Many2one('eva.call.training', required=True, index=True, ondelete='cascade')
    map_id = fields.Many2one(related='training_id.map_id', store=True, index=True)
    date = fields.Datetime(related='training_id.start_date', store=True)
    user_id = fields.Many2one('res.users', required=True, index=True, ondelete='cascade')
    avatar_128 = fields.Image(related='user_id.avatar_128')
    state = fields.Selection([
        ('waiting', 'Waiting'),
        ('playing', 'Playing'),
        ('finished', 'Finished'),
    ], required=True, default='waiting')
    round_started_at = fields.Float(help='Epoch timestamp at which the current round was shown.')
    last_activity = fields.Float(help='Epoch timestamp of the last round served to or answered by this player.')
    answer_ids = fields.One2many('eva.call.training.answer', 'participant_id')
    answered_count = fields.Integer(compute='_compute_stats', store=True)
    correct_count = fields.Integer('Correct', compute='_compute_stats', store=True, aggregator='sum')
    mistake_count = fields.Integer('Mistakes', compute='_compute_stats', store=True, aggregator='sum')
    score = fields.Integer(compute='_compute_stats', store=True, aggregator='avg')
    accuracy = fields.Float('Accuracy (%)', compute='_compute_stats', store=True, aggregator='avg')
    avg_response_time = fields.Float('Avg. Answer Time (s)', compute='_compute_stats', store=True, aggregator='avg',
                                     help='Average time taken to give a correct answer.')
    lives_left = fields.Integer(compute='_compute_lives_left')
    round_count = fields.Integer(related='training_id.round_count')

    _training_user_uniq = models.Constraint(
        'UNIQUE (training_id, user_id)',
        'A user can only take part once in a given training.',
    )

    @api.depends('answer_ids.result', 'answer_ids.points', 'answer_ids.response_time')
    def _compute_stats(self):
        for participant in self:
            answers = participant.answer_ids
            correct = answers.filtered(lambda a: a.result == 'correct')
            participant.answered_count = len(answers)
            participant.correct_count = len(correct)
            participant.mistake_count = len(answers) - len(correct)
            participant.score = sum(answers.mapped('points'))
            # Accuracy over the whole training: rounds not reached after
            # running out of lives count as missed.
            round_count = participant.training_id.round_count
            participant.accuracy = 100 * len(correct) / round_count if round_count else 0
            participant.avg_response_time = (
                sum(correct.mapped('response_time')) / len(correct) if correct else 0
            )

    @api.depends('training_id.lives', 'mistake_count')
    def _compute_lives_left(self):
        for participant in self:
            participant.lives_left = participant.training_id.lives - participant.mistake_count

    def _get_ranks(self):
        """Competition ranking ("1, 2, 2, 4") within each participant's training,
        by score then by average answer time."""
        ranks = {}
        for training in self.training_id:
            ordered = training.participant_ids.sorted(lambda p: (-p.score, p.avg_response_time or 0))
            previous_key, previous_rank = None, 0
            for index, participant in enumerate(ordered, 1):
                key = (participant.score, participant.avg_response_time)
                rank = previous_rank if key == previous_key else index
                ranks[participant.id] = rank
                previous_key, previous_rank = key, rank
        return ranks

    def _get_image_url(self, round_number):
        return f'/eva/call_trainer/{self.id}/{round_number}/image'

    def _check_is_me(self):
        self.ensure_one()
        if self.user_id != self.env.user:
            raise UserError(self.env._('You can only play your own rounds.'))

    def _finish(self):
        self.write({'state': 'finished', 'round_started_at': 0})
        self.training_id._touch()
        self.training_id._check_done()

    def _record_answer(self, answer, now):
        """Record the answer to the current round and move on to the next one."""
        self.ensure_one()
        training = self.training_id
        current_round = training.round_ids.sorted('sequence')[self.answered_count]
        elapsed = now - self.round_started_at if self.round_started_at else training.time_per_round
        answer = (answer or '').strip()
        if not answer or elapsed > training.time_per_round + ANSWER_GRACE_SECONDS:
            result = 'timeout'
        elif current_round.call_id._is_answer_correct(answer):
            result = 'correct'
        else:
            result = 'wrong'
        response_time = min(elapsed, training.time_per_round)
        points = 0
        if result == 'correct':
            speed_ratio = max(0, 1 - response_time / training.time_per_round)
            points = CORRECT_POINTS + round(SPEED_BONUS_POINTS * speed_ratio)
        self.env['eva.call.training.answer'].sudo().create({
            'participant_id': self.id,
            'round_id': current_round.id,
            'round_number': current_round.sequence + 1,
            'call_id': current_round.call_id.id,
            'image_id': current_round.image_id.id,
            'answer': answer,
            'result': result,
            'response_time': response_time,
            'points': points,
        })
        self.write({'round_started_at': 0, 'last_activity': now})
        if self.lives_left < 0 or self.answered_count >= training.round_count:
            self._finish()
        return {
            'result': result,
            'points': points,
            'expected': current_round.call_id.name,
            'answer': answer,
        }

    def get_current_round(self):
        """Serve the current round to its player, starting its timer the first
        time it's asked for. Asking again (e.g. after a page reload) doesn't
        restart the timer, and a round whose time ran out while away counts as
        timed out."""
        self.ensure_one()
        self._check_is_me()
        participant = self.sudo()
        training = participant.training_id
        if training.state != 'running' or participant.state != 'playing':
            return False
        now = time.time()
        if participant.round_started_at and now - participant.round_started_at > training.time_per_round + ANSWER_GRACE_SECONDS:
            participant._record_answer('', now)
            training._notify_update()
            if participant.state != 'playing':
                return False
        if not participant.round_started_at:
            participant.write({'round_started_at': now, 'last_activity': now})
        round_number = participant.answered_count + 1
        return {
            'round_number': round_number,
            'image_url': participant._get_image_url(round_number),
            'time_left': max(0, training.time_per_round - (now - participant.round_started_at)),
        }

    def submit_answer(self, round_number, answer):
        """Answer the given round. ``round_number`` guards against double
        submissions (e.g. Enter pressed twice, or a timeout racing a submit):
        an answer for a round that isn't the current one is ignored."""
        self.ensure_one()
        self._check_is_me()
        participant = self.sudo()
        if participant.state != 'playing' or participant.answered_count + 1 != round_number:
            return False
        result = participant._record_answer(answer, time.time())
        result.update({
            'score': participant.score,
            'lives_left': participant.lives_left,
            'finished': participant.state == 'finished',
        })
        participant.training_id._notify_update()
        return result


class EvaCallTrainingAnswer(models.Model):
    """One answer of one participant to one round. This is the history used to
    analyze progress per call over time."""
    _name = 'eva.call.training.answer'
    _description = 'EVA Call Training Answer'
    _order = 'date desc, round_number'
    _rec_name = 'call_id'

    participant_id = fields.Many2one('eva.call.training.participant', required=True, index=True, ondelete='cascade')
    training_id = fields.Many2one(related='participant_id.training_id', store=True, index=True)
    user_id = fields.Many2one(related='participant_id.user_id', store=True, index=True)
    map_id = fields.Many2one(related='participant_id.map_id', store=True, index=True)
    round_id = fields.Many2one('eva.call.training.round', ondelete='set null')
    round_number = fields.Integer()
    call_id = fields.Many2one('eva.map.call', required=True, index=True, ondelete='cascade')
    image_id = fields.Many2one('eva.map.call.image', ondelete='set null')
    image = fields.Image('Thumbnail', related='image_id.image_512')
    answer = fields.Char()
    result = fields.Selection([
        ('correct', 'Correct'),
        ('wrong', 'Wrong'),
        ('timeout', 'Timed Out'),
    ], required=True)
    is_correct = fields.Boolean(compute='_compute_is_correct', store=True)
    success_rate = fields.Float('Success Rate (%)', compute='_compute_is_correct', store=True, aggregator='avg')
    response_time = fields.Float('Answer Time (s)', aggregator='avg')
    points = fields.Integer(aggregator='sum')
    date = fields.Datetime(default=fields.Datetime.now, required=True, index=True)

    @api.depends('result')
    def _compute_is_correct(self):
        for answer in self:
            answer.is_correct = answer.result == 'correct'
            # 100/0 per answer, so that averaging it in graph/pivot views gives a success rate.
            answer.success_rate = 100 if answer.is_correct else 0
