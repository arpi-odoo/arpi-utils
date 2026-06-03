from odoo import api, fields, models


class EvaMap(models.Model):
    _name = 'eva.map'
    _description = 'EVA Map'
    _inherit = ['mail.thread']

    name = fields.Char(required=True)
    banner = fields.Image()
    banner_card = fields.Image(related='banner', max_width=512, max_height=288, store=True)
    minimap = fields.Image()
    tactics = fields.Html()
    comments = fields.Html()
    eva_gg_id = fields.Char(string='eva.gg Map ID', index=True, copy=False)

    game_ids = fields.One2many('eva.game', 'map_id')
    game_count = fields.Integer(compute='_compute_game_count')
    my_team_game_count = fields.Integer(compute='_compute_my_team_game_count')
    session_count = fields.Integer(compute='_compute_session_count')
    my_team_session_count = fields.Integer(compute='_compute_session_count')

    @api.depends('game_ids')
    def _compute_game_count(self):
        for _map in self:
            _map.game_count = len(_map.game_ids)

    def _compute_my_team_game_count(self):
        my_team = self.env['eva.player'].search([('user_id', '=', self.env.uid)], limit=1).team_id
        for _map in self:
            _map.my_team_game_count = len(_map.game_ids.filtered(
                lambda game: my_team and my_team in (game.team_1_id, game.team_2_id)))

    @api.depends('game_ids.session_id')
    def _compute_session_count(self):
        my_team = self.env['eva.player'].search([('user_id', '=', self.env.uid)], limit=1).team_id
        for _map in self:
            _map.session_count = len(_map.game_ids.session_id)
            my_team_games = _map.game_ids.filtered(
                lambda game: my_team and my_team in (game.team_1_id, game.team_2_id))
            _map.my_team_session_count = len(my_team_games.session_id)

    def action_open_sessions(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': 'Sessions',
            'res_model': 'eva.session',
            'view_mode': 'kanban,calendar,list,form',
            'domain': [('game_ids.map_id', '=', self.id)],
            'context': {
                'map_id': self.id,
                'search_default_my_team_on_map': 1,
            },
        }

    def action_open_games(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': 'Games',
            'res_model': 'eva.game',
            'view_mode': 'kanban,calendar,list',
            'domain': [('id', 'in', self.game_ids.ids)],
            'context': {
                'search_default_group_by_month': 1,
                'search_default_my_team': 1,
            }
        }

    def action_open_game_results(self):
        self.ensure_one()
        player = self.env['eva.player'].search([('user_id', '=', self.env.uid)], limit=1)
        return {
            'type': 'ir.actions.act_window',
            'name': f'Results on {self.name}',
            'res_model': 'eva.game.result',
            'view_mode': 'graph,pivot,list',
            'domain': [('map_id', '=', self.id)],
            'context': {
                'search_default_team_id': player.team_id.id,
                'search_default_group_by_month': 1,
                'search_default_group_by_result': 2,
            },
        }
