from odoo import api, fields, models


class EvaTeam(models.Model):
    _name = 'eva.team'
    _description = 'EVA Team'
    _rec_names_search = ('name', 'short_name')

    name = fields.Char(required=True)
    short_name = fields.Char(required=True)
    display_name = fields.Char(compute='_compute_display_name')
    player_ids = fields.One2many('eva.player', 'team_id')
    eva_gg_id = fields.Char(string='eva.gg Team ID', index=True, copy=False)

    @api.depends('name', 'short_name')
    def _compute_display_name(self):
        for team in self:
            team.display_name = f'{team.name} ({team.short_name})'

    def action_open_game_results(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': f'{self.name} Results',
            'res_model': 'eva.game.result',
            'view_mode': 'graph,pivot,list',
            'domain': [('team_id', '=', self.id)],
            'context': {
                'search_default_group_by_month': 1,
                'search_default_group_by_result': 2,
            },
        }
