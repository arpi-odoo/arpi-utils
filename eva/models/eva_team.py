import json
from collections import defaultdict

from odoo import api, fields, models
from odoo.tools import format_date


class EvaTeam(models.Model):
    _name = 'eva.team'
    _description = 'EVA Team'
    _rec_names_search = ('name', 'short_name')

    name = fields.Char(required=True)
    short_name = fields.Char(required=True)
    display_name = fields.Char(compute='_compute_display_name')
    player_ids = fields.One2many('eva.player', 'team_id')
    captain_id = fields.Many2one('eva.player', string='Captain', domain="[('id', 'in', player_ids)]")
    eva_gg_id = fields.Char(string='eva.gg Team ID', index=True, copy=False)

    @api.depends('name', 'short_name')
    def _compute_display_name(self):
        for team in self:
            team.display_name = f'{team.name} ({team.short_name})'

    @api.model
    def _get_home_chart_data(self, short_name='TS'):
        """JSON payload matching the website builder's `s_chart` `data-data` format,
        so it can drop straight into that attribute in place of a hardcoded value."""
        team = self.sudo().search([('short_name', '=', short_name)], limit=1)
        results = self.env['eva.game.result'].sudo().search([
            ('team_id', '=', team.id),
            ('result', 'in', ('win', 'loss')),
        ], order='datetime')

        counts = defaultdict(lambda: {'win': 0, 'loss': 0})
        months = []
        for result in results:
            month = format_date(self.env, result.datetime, date_format='MMMM')
            if month not in counts:
                months.append(month)
            counts[month][result.result] += 1

        return json.dumps({
            'labels': months,
            'datasets': [
                {'label': self.env._('Wins'), 'data': [str(counts[m]['win']) for m in months],
                 'backgroundColor': 'o-color-2', 'borderColor': 'o-color-2', 'key': 'chart_dataset_wins'},
                {'label': self.env._('Losses'), 'data': [str(counts[m]['loss']) for m in months],
                 'backgroundColor': 'o-color-1', 'borderColor': 'o-color-1', 'key': 'chart_dataset_losses'},
            ],
        })

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
