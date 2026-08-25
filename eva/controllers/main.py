from odoo import http
from odoo.http import request


class EvaWebsite(http.Controller):

    @http.route('/team', type='http', auth='public', website=True, sitemap=True)
    def team_page(self, **kwargs):
        teams = request.env['eva.team'].sudo().search([('short_name', '=', 'TS')], order='name')
        players = request.env['eva.player'].sudo()
        for team in teams:
            players |= team.captain_id + (team.player_ids - team.captain_id)
        captain_ids = set(teams.captain_id.ids)
        return request.render('eva.team_page_template', {'players': players, 'captain_ids': captain_ids})
