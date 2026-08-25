from datetime import timedelta

from odoo import api, fields, models
from odoo.exceptions import ValidationError
from odoo.fields import Command

# Purely for calendar display (how long an event visually spans); not tied to
# any specific game's real duration.
SESSION_DURATION = timedelta(minutes=50)

# Indices into Odoo's own named color palette (kanban tag colors / calendar
# event colors), picked to match: draft=blue, confirmed (me playing)=green,
# confirmed (me not playing)=red, done/cancelled=gray.
CALENDAR_COLOR_GRAY = 0
CALENDAR_COLOR_RED = 1
CALENDAR_COLOR_BLUE = 8
CALENDAR_COLOR_GREEN = 10


class EvaSession(models.Model):
    _name = 'eva.session'
    _description = 'EVA Session'
    _inherit = ['mail.thread']
    _order = 'datetime desc'

    name = fields.Char(compute='_compute_name')
    display_name = fields.Char(compute='_compute_name')
    datetime = fields.Datetime(required=True, string='Date', default=lambda self: fields.Datetime.now())
    datetime_end = fields.Datetime(compute='_compute_datetime_end', store=True)
    state = fields.Selection([
        ('draft', 'Draft'),
        ('confirmed', 'Confirmed'),
        ('done', 'Done'),
        ('cancelled', 'Cancelled'),
    ], default='draft', required=True, group_expand=True)
    type = fields.Selection(
        selection=[
            ('league', 'League'),
            ('scrim', 'Scrim'),
            ('classic', 'EVA: Battle Arena'),
            ('zombie', 'Zombie: Moon of the Dead'),
            ('rabbids', 'Rabbids: Color Chaos'),
            ('other', 'Other'),
        ],
        required=True, default='league', string='Game Type')
    division = fields.Selection(
        selection=[
            ('D1', 'D1'),
            ('D2', 'D2'),
            ('D3', 'D3'),
            ('D4', 'D4'),
        ],
        required=True, default='D1')
    player_ids = fields.Many2many(
        'eva.player', 'eva_session_player_rel', string='Players',
        default=lambda self: self._default_player_ids())
    token_cost = fields.Integer(required=True, default=1)
    advanced_cost_distribution = fields.Boolean(default=False)
    token_move_ids = fields.One2many(
        'eva.token.move', 'session_id',
        compute='_compute_token_move_ids', store=True, readonly=False)
    warning_text = fields.Char(compute='_compute_warning_text', store=True)
    token_status = fields.Selection([
        ('ok', 'Ok'),
        ('warning', 'Warning'),
    ], compute='_compute_warning_text', store=True)
    analysis = fields.Html()
    eva_gg_session_key = fields.Char(string='eva.gg Session Key', index=True, copy=False)

    game_ids = fields.One2many('eva.game', 'session_id')
    game_count = fields.Integer(compute='_compute_game_count')
    my_team_game_count = fields.Integer(compute='_compute_my_team_game_count')
    matchup_ids = fields.One2many('eva.session.matchup', 'session_id', string='Matchups', readonly=True)
    calendar_color = fields.Integer(compute='_compute_calendar_color')

    def _default_player_ids(self):
        player = self.env['eva.player'].search([('user_id', '=', self.env.uid)], limit=1)
        return player.team_id.player_ids.ids

    @api.depends('game_ids')
    def _compute_game_count(self):
        for session in self:
            session.game_count = len(session.game_ids)

    def _compute_my_team_game_count(self):
        my_team = self.env['eva.player'].search([('user_id', '=', self.env.uid)], limit=1).team_id
        for session in self:
            session.my_team_game_count = len(session.game_ids.filtered(
                lambda game: my_team and my_team in (game.team_1_id, game.team_2_id)))

    @api.depends('datetime')
    def _compute_datetime_end(self):
        for session in self:
            session.datetime_end = session.datetime and session.datetime + SESSION_DURATION

    def _compute_calendar_color(self):
        my_player = self.env['eva.player'].search([('user_id', '=', self.env.uid)], limit=1)
        now = fields.Datetime.now()
        for session in self:
            if session.state == 'draft':
                session.calendar_color = CALENDAR_COLOR_BLUE
            elif session.state == 'confirmed' and session.datetime >= now:
                # A confirmed session whose time has already passed (e.g. a booking-
                # synced session, which never gets promoted to 'done' since we have no
                # results to attach) reads as done, not as still-needing-attention.
                session.calendar_color = (
                    CALENDAR_COLOR_GREEN if my_player and my_player in session.player_ids else CALENDAR_COLOR_RED)
            else:
                session.calendar_color = CALENDAR_COLOR_GRAY

    def action_open_games(self):
        self.ensure_one()
        context = {'search_default_group_by_winner': 1}
        if self.my_team_game_count:
            context['search_default_my_team'] = 1

        return {
            'type': 'ir.actions.act_window',
            'name': 'Games',
            'res_model': 'eva.game',
            'view_mode': 'kanban,list,form',
            'domain': [('session_id', '=', self.id)],
            'context': context,
        }

    def action_new_game(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'res_model': 'eva.game',
            'views': [(False, 'form')],
            'context': {'default_session_id': self.id},
        }

    @api.depends('state', 'type', 'division')
    def _compute_name(self):
        game_type_selection = dict(self._fields['type']._description_selection(self.env))
        for session in self:
            name = game_type_selection[session.type]
            if session.type == 'league':
                name += f' {session.division}'
            session.name = name
            session.display_name = f'{name} - {session.datetime.date()}'

    @api.depends('player_ids.token_balance', 'token_cost', 'advanced_cost_distribution', 'token_move_ids.cost')
    def _compute_warning_text(self):
        for session in self:
            # In advanced mode each player's actual cost is their own (manually editable)
            # move, not the shared token_cost; depending on 'token_move_ids.cost' (rather
            # than only the underlying 'amount') also keeps this reactive to edits made
            # directly in that list, since 'cost' is the field actually shown/edited there.
            moves_by_player = {
                move.player_id: move for move in session.token_move_ids if move.move_type == 'session'}

            def player_cost(player):
                move = moves_by_player.get(player)
                if session.advanced_cost_distribution and move:
                    return move.cost
                return session.token_cost

            players_not_enough_tokens = session.player_ids.filtered(
                lambda p: p.token_balance < player_cost(p))
            if players_not_enough_tokens:
                players_str = ', '.join(player.name for player in players_not_enough_tokens)
                session.warning_text = 'Players without enough tokens: ' + players_str
                session.token_status = 'warning'
            else:
                session.warning_text = False
                session.token_status = 'ok'

    @api.depends('player_ids', 'state', 'token_cost', 'advanced_cost_distribution', 'datetime')
    def _compute_token_move_ids(self):
        for session in self:
            # Membership, the move's lifecycle state, and its date always stay in sync, in
            # both modes. 'advanced_cost_distribution' only controls whether the *amount*
            # keeps tracking token_cost/balance, or is left to manual edits.
            move_state = 'cancelled' if session.state == 'cancelled' else 'draft' if session.state == 'draft' else 'done'
            move_date = session.datetime.date()
            # Keyed by the underlying real id (not the recordset itself): during onchange,
            # session.player_ids yields NewId-wrapped players while move.player_id (accessed
            # through an already-real move) is the plain real record, and Odoo doesn't
            # consider those equal even though they represent the same player.
            moves_by_player = {
                move.player_id._origin.id: move
                for move in session.token_move_ids if move.move_type == 'session'
            }

            commands = []
            for player in session.player_ids:
                move = moves_by_player.pop(player._origin.id, None)
                if move:
                    values = {}
                    if move.state != move_state:
                        values['state'] = move_state
                    if move.date != move_date:
                        values['date'] = move_date
                    if not session.advanced_cost_distribution:
                        amount = -min(session.token_cost, player.token_balance)
                        if move.amount != amount:
                            values['amount'] = amount
                    if values:
                        commands.append(Command.update(move.id, values))
                else:
                    commands.append(Command.create({
                        'player_id': player.id,
                        'amount': -min(session.token_cost, player.token_balance),
                        'move_type': 'session',
                        'date': move_date,
                        'state': move_state,
                    }))

            # Players no longer on the session: always drop their move (membership stays 1:1
            # with player_ids regardless of advanced_cost_distribution).
            for move in moves_by_player.values():
                commands.append(Command.delete(move.id))

            session.token_move_ids = commands or session.token_move_ids

    def write(self, vals):
        new_state = vals.get('state')
        if new_state:
            # Token moves stay in sync automatically via _compute_token_move_ids
            # (it depends on 'state'); only the transition guard belongs here.
            self.filtered(lambda s: s.state != new_state)._check_state_transition(new_state)
        return super().write(vals)

    def unlink(self):
        self._unlink_token_moves()
        return super().unlink()

    def _check_state_transition(self, new_state):
        if new_state == 'done':
            for session in self:
                if session.datetime > fields.Datetime.now():
                    raise ValidationError('You cannot finish a session in the future')

    def _unlink_token_moves(self):
        moves_by_session = dict(self.env['eva.token.move']._read_group(
            domain=[('session_id', 'in', self.ids), ('move_type', '=', 'session')],
            groupby=['session_id'],
            aggregates=['id:recordset']))
        empty = self.env['eva.token.move']
        for session in self:
            moves_by_session.get(session, empty).unlink()
