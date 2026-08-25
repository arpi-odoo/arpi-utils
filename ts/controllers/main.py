from odoo import http
from odoo.http import request
from odoo.tools import consteq


class TsController(http.Controller):

    @http.route('/ts/meetings/<int:uid>/<string:token>.ics', type='http', auth='public')
    def ts_meetings_feed(self, uid, token, **kwargs):
        user = request.env['res.users'].sudo().browse(uid)
        if not user.exists() or not user.ts_meeting_feed_token or not consteq(user.ts_meeting_feed_token, token):
            return request.not_found()

        meetings = request.env['ts.meeting'].sudo().search([])
        content = meetings._get_ics_feed()
        return request.make_response(content, [
            ('Content-Type', 'text/calendar; charset=utf-8'),
            ('Content-Length', len(content)),
        ])
