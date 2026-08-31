from odoo import http
from odoo.http import request
from odoo.tools import consteq


class EvaWebsite(http.Controller):

    @http.route('/team', type='http', auth='public', website=True, sitemap=True)
    def team_page(self, **kwargs):
        teams = request.env['eva.team'].sudo().search([('short_name', '=', 'TS')], order='name')
        players = request.env['eva.player'].sudo()
        for team in teams:
            players |= team.captain_id + (team.player_ids - team.captain_id)
        captain_ids = set(teams.captain_id.ids)
        return request.render('eva.team_page_template', {'players': players, 'captain_ids': captain_ids})

    @http.route('/eva/sessions/<int:uid>/<string:token>.ics', type='http', auth='public')
    def eva_sessions_feed(self, uid, token, **kwargs):
        user = request.env['res.users'].sudo().browse(uid)
        if not user.exists() or not user.eva_session_feed_token or not consteq(user.eva_session_feed_token, token):
            return request.not_found()

        sessions = request.env['eva.session'].sudo().search([('player_ids.user_id', '=', user.id)])
        content = sessions._get_ics_feed()
        return request.make_response(content, [
            ('Content-Type', 'text/calendar; charset=utf-8'),
            ('Content-Length', len(content)),
        ])
