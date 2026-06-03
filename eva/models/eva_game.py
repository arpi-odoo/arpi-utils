from odoo import api, fields, models


class EvaGame(models.Model):
    _name = 'eva.game'
    _description = 'EVA Game'
    _inherit = ['mail.thread']
    _order = 'datetime desc, session_id, winner, map_id'

    name = fields.Char(compute='_compute_name')
    replay = fields.Char()
    ebp = fields.Char(string='EBP')

    map_id = fields.Many2one('eva.map', required=True)
    banner = fields.Image(related='map_id.banner')
    session_id = fields.Many2one('eva.session', required=True)
    player_ids = fields.Many2many(related='session_id.player_ids')
    datetime = fields.Datetime(related='session_id.datetime', store=True, index=True)

    division = fields.Selection(related='session_id.division')
    team_1_id = fields.Many2one('eva.team', index=True)
    team_1_short_name = fields.Char(related='team_1_id.short_name')
    team_2_id = fields.Many2one('eva.team', index=True)
    team_2_short_name = fields.Char(related='team_2_id.short_name')
    winner = fields.Many2one('eva.team', domain="[('id', 'in', [team_1_id, team_2_id])]")
    winner_short_name = fields.Char(related='winner.short_name')
    winner_is_my_team = fields.Boolean(compute='_compute_my_team_result')
    loser = fields.Many2one('eva.team', compute='_compute_loser')
    loser_is_my_team = fields.Boolean(compute='_compute_my_team_result')

    analysis = fields.Html()
    eva_gg_match_id = fields.Char(string='eva.gg Match ID', index=True, copy=False)

    @api.depends('team_1_id.short_name', 'team_2_id.short_name', 'map_id.name')
    def _compute_name(self):
        for game in self:
            name = False
            if game.map_id.name:
                name = f'{game.map_id.name}'
                if game.team_1_id.short_name and game.team_2_id.short_name:
                    name += f' - {game.team_1_id.short_name} vs {game.team_2_id.short_name}'
            game.name = name

    def _compute_my_team_result(self):
        my_team = self.env['eva.player'].search([('user_id', '=', self.env.uid)], limit=1).team_id
        for game in self:
            game.winner_is_my_team = bool(my_team) and game.winner == my_team
            game.loser_is_my_team = bool(my_team) and game.loser == my_team

    @api.depends('team_1_id', 'team_2_id', 'winner')
    def _compute_loser(self):
        for game in self:
            if not game.winner:
                game.loser = False
            elif game.winner == game.team_1_id:
                game.loser = game.team_2_id
            else:
                game.loser = game.team_1_id
