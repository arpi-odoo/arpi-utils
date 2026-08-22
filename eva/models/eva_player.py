from dateutil.relativedelta import relativedelta

from odoo import api, fields, models


class EvaPlayer(models.Model):
    _name = 'eva.player'
    _description = 'EVA Player'
    _order = 'name'

    name = fields.Char('Username', required=True)
    player_name = fields.Char(related='user_id.name')
    user_id = fields.Many2one('res.users', index=True)
    avatar_128 = fields.Image(related='user_id.avatar_128')
    team_id = fields.Many2one('eva.team', index=True)
    eva_gg_id = fields.Char(string='eva.gg Player ID', index=True, copy=False)
    session_ids = fields.Many2many('eva.session', 'eva_session_player_rel', string='Sessions')
    session_count = fields.Integer(compute='_compute_session_count')

    tokens_per_month = fields.Integer(required=True, default=0)
    tokens_grant_day = fields.Integer(required=True, default=1)
    token_move_ids = fields.One2many('eva.token.move', 'player_id')
    token_move_count = fields.Integer(compute='_compute_token_move_count')
    token_balance = fields.Integer(compute='_compute_token_balance', inverse='_inverse_token_balance', store=True)
    tokens_reserved = fields.Integer(compute='_compute_tokens_reserved', store=True)
    tokens_available = fields.Integer(compute='_compute_tokens_available', store=True)

    @api.depends('token_move_ids.amount')
    def _compute_token_balance(self):
        for player in self:
            player.token_balance = sum(player.token_move_ids.filtered(lambda m: m.state == 'done').mapped('amount'))

    def _inverse_token_balance(self):
        for player in self:
            diff = player.token_balance - sum(player.token_move_ids.filtered(lambda m: m.state == 'done').mapped('amount'))
            if diff:
                self.env['eva.token.move'].create({
                    'player_id': player.id,
                    'amount': diff,
                    'move_type': 'manual',
                    'date': fields.Date.today(),
                })

    @api.depends('session_ids.token_cost', 'token_balance')
    def _compute_tokens_reserved(self):
        for player in self:
            tokens_reserved = -sum(player.token_move_ids.filtered(lambda m: m.state == 'draft').mapped('amount'))
            player.tokens_reserved = min(tokens_reserved, player.token_balance)

    @api.depends('token_balance', 'tokens_reserved')
    def _compute_tokens_available(self):
        for player in self:
            player.tokens_available = player.token_balance - player.tokens_reserved

    def _compute_token_move_count(self):
        for player in self:
            player.token_move_count = len(player.token_move_ids)

    def _compute_session_count(self):
        for player in self:
            player.session_count = len(player.session_ids.filtered(lambda s: s.state != 'cancelled'))

    def action_open_sessions(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': 'Sessions',
            'res_model': 'eva.session',
            'view_mode': 'kanban,calendar,list,form',
            'domain': [('id', 'in', self.session_ids.ids), ('state', '!=', 'cancelled')],
        }

    def action_open_token_moves(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': f"{self.name}'s Token Moves",
            'res_model': 'eva.token.move',
            'view_mode': 'list',
            'domain': [('id', 'in', self.token_move_ids.ids)],
        }

    @api.model
    def _tokens_subscriptions(self):
        today = fields.Date.today()
        players_with_subscription = self.search([('tokens_per_month', '>', 0)])
        last_day_of_month = (today + relativedelta(day=31)).day
        players_to_grant_tokens = players_with_subscription.filtered(
            lambda p: min(p.tokens_grant_day, last_day_of_month) == today.day)

        for player in players_to_grant_tokens:
            self.env['eva.token.move'].create({
                'player_id': player.id,
                'amount': player.tokens_per_month,
                'move_type': 'subscription',
                'date': today,
            })