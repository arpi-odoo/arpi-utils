from odoo import api, fields, models


class EvaTokenMove(models.Model):
    _name = 'eva.token.move'
    _description = 'EVA Token Move'
    _order = 'date DESC, state DESC, move_type'

    player_id = fields.Many2one('eva.player', required=True)
    amount = fields.Integer(required=True)
    cost = fields.Integer(compute='_compute_cost', inverse='_inverse_cost', store=True, readonly=False)
    date = fields.Date(required=True, default=fields.Date.today)
    move_type = fields.Selection([
        ('subscription', 'Subscription'),
        ('session', 'Session'),
        ('manual', 'Manual'),
    ], required=True, default='manual')
    session_id = fields.Many2one('eva.session')
    state = fields.Selection([
        ('draft', 'Draft'),
        ('done', 'Done'),
        ('cancelled', 'Cancelled'),
    ], required=True, default='done')

    def _inverse_cost(self):
        for move in self:
            move.amount = -move.cost

    @api.depends('amount')
    def _compute_cost(self):
        for move in self:
            move.cost = -move.amount
