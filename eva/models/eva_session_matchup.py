from odoo import fields, models
from odoo.tools import SQL


class EvaSessionMatchup(models.Model):
    _name = 'eva.session.matchup'
    _description = 'EVA Session Matchup'
    _auto = False
    _order = 'game_count desc'

    name = fields.Char(compute='_compute_name', string='Matchup')
    score = fields.Char(compute='_compute_score')
    session_id = fields.Many2one('eva.session', readonly=True)
    team_a_id = fields.Many2one('eva.team', readonly=True, string='Team')
    team_b_id = fields.Many2one('eva.team', readonly=True, string='Opponent')
    team_a_wins = fields.Integer(readonly=True, string='Team Wins')
    team_b_wins = fields.Integer(readonly=True, string='Opponent Wins')
    game_count = fields.Integer(readonly=True, string='Games')
    team_a_maps = fields.Char(compute='_compute_maps')
    team_b_maps = fields.Char(compute='_compute_maps')
    team_a_name = fields.Char(compute='_compute_team_names')
    team_b_name = fields.Char(compute='_compute_team_names')

    def _compute_name(self):
        for matchup in self:
            matchup.name = f'{matchup.team_a_id.display_name} vs {matchup.team_b_id.display_name}'

    def _compute_team_names(self):
        for matchup in self:
            matchup.team_a_name = matchup.team_a_id.display_name
            matchup.team_b_name = matchup.team_b_id.display_name

    def _compute_score(self):
        for matchup in self:
            matchup.score = f'{matchup.team_a_wins} - {matchup.team_b_wins}'

    def _compute_maps(self):
        for matchup in self:
            games = self.env['eva.game'].search(matchup._games_domain())
            matchup.team_a_maps = '\n'.join(
                games.filtered(lambda g: g.winner == matchup.team_a_id).mapped('map_id.name')) or '-'
            matchup.team_b_maps = '\n'.join(
                games.filtered(lambda g: g.winner == matchup.team_b_id).mapped('map_id.name')) or '-'

    def _games_domain(self):
        self.ensure_one()
        return [
            ('session_id', '=', self.session_id.id),
            '|',
            '&', ('team_1_id', '=', self.team_a_id.id), ('team_2_id', '=', self.team_b_id.id),
            '&', ('team_1_id', '=', self.team_b_id.id), ('team_2_id', '=', self.team_a_id.id),
        ]

    def action_open_games(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': self.name,
            'res_model': 'eva.game',
            'view_mode': 'kanban,list,form',
            'domain': self._games_domain(),
            'context': {
                'search_default_group_by_winner': 1,
            }
        }

    @property
    def _table_sql(self):
        return SQL("""(
            SELECT MIN(g.id) AS id,
                   g.session_id AS session_id,
                   LEAST(g.team_1_id, g.team_2_id) AS team_a_id,
                   GREATEST(g.team_1_id, g.team_2_id) AS team_b_id,
                   COUNT(*) FILTER (WHERE g.winner = LEAST(g.team_1_id, g.team_2_id)) AS team_a_wins,
                   COUNT(*) FILTER (WHERE g.winner = GREATEST(g.team_1_id, g.team_2_id)) AS team_b_wins,
                   COUNT(*) AS game_count
              FROM eva_game g
             WHERE g.team_1_id IS NOT NULL AND g.team_2_id IS NOT NULL
             GROUP BY g.session_id, LEAST(g.team_1_id, g.team_2_id), GREATEST(g.team_1_id, g.team_2_id)
        )""")
