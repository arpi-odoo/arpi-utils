from odoo import api, fields, models
from odoo.tools import SQL


class EvaGameResult(models.Model):
    _name = 'eva.game.result'
    _description = 'EVA Game Result (per team)'
    _auto = False
    _order = 'datetime desc, result'

    name = fields.Char(compute='_compute_name')
    game_id = fields.Many2one('eva.game', readonly=True)
    session_id = fields.Many2one(related='game_id.session_id')
    banner = fields.Image(related='game_id.banner')
    write_date = fields.Datetime(related='game_id.write_date')
    team_id = fields.Many2one('eva.team', readonly=True)
    opponent_id = fields.Many2one('eva.team', readonly=True)
    map_id = fields.Many2one('eva.map', readonly=True)
    datetime = fields.Datetime(readonly=True)
    session_type = fields.Selection([
        ('league', 'League'),
        ('scrim', 'Scrim'),
        ('classic', 'EVA: Battle Arena'),
        ('zombie', 'Zombie: Moon of the Dead'),
        ('rabbids', 'Rabbids: Color Chaos'),
        ('other', 'Other'),
    ], readonly=True, string='Game Type')
    result = fields.Selection([
        ('win', 'Win'),
        ('draw', 'Draw'),
        ('loss', 'Loss'),
    ], readonly=True)

    def _compute_name(self):
        for game_result in self:
            game_result.name = f'{game_result.map_id.name} - {game_result.team_id.name} vs {game_result.opponent_id.name}'

    def action_open_game(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'res_model': 'eva.game',
            'res_id': self.game_id.id,
            'views': [(False, 'form')],
        }

    @api.model
    def action_open_games(self, domain):
        """Translate a graph click's domain (expressed on this per-team virtual
        model) into the underlying real eva.game records, and open those
        instead of this model's own list/form, grouped by winner rather than
        by the per-team 'result' dimension used in the graph."""
        game_ids = self.search(domain).mapped('game_id').ids
        return {
            'type': 'ir.actions.act_window',
            'name': 'Games',
            'res_model': 'eva.game',
            # 'views' (not the 'view_mode' shorthand) is required here: this action
            # is returned straight to an ORM call and passed to doAction() as-is,
            # bypassing the server-side action-cleaning step (clean_action) that
            # normally expands 'view_mode' into 'views' for button-triggered actions.
            'views': [(False, 'kanban'), (False, 'calendar'), (False, 'list'), (False, 'form')],
            'domain': [('id', 'in', game_ids)],
            'context': {
                'search_default_group_by_winner': 1,
            },
        }

    @property
    def _table_sql(self):
        return SQL("""(
            SELECT g.id * 2 AS id,
                   g.id AS game_id,
                   g.team_1_id AS team_id,
                   g.team_2_id AS opponent_id,
                   g.map_id AS map_id,
                   s.datetime AS datetime,
                   s.type AS session_type,
                   CASE WHEN g.winner IS NULL THEN 'draw'
                        WHEN g.winner = g.team_1_id THEN 'win'
                        ELSE 'loss' END AS result
              FROM eva_game g
              JOIN eva_session s ON s.id = g.session_id
             WHERE g.team_1_id IS NOT NULL AND g.team_2_id IS NOT NULL

             UNION ALL

            SELECT g.id * 2 + 1 AS id,
                   g.id AS game_id,
                   g.team_2_id AS team_id,
                   g.team_1_id AS opponent_id,
                   g.map_id AS map_id,
                   s.datetime AS datetime,
                   s.type AS session_type,
                   CASE WHEN g.winner IS NULL THEN 'draw'
                        WHEN g.winner = g.team_2_id THEN 'win'
                        ELSE 'loss' END AS result
              FROM eva_game g
              JOIN eva_session s ON s.id = g.session_id
             WHERE g.team_1_id IS NOT NULL AND g.team_2_id IS NOT NULL
        )""")
