import uuid

from odoo import fields, models


class ResUsers(models.Model):
    _inherit = 'res.users'

    eva_session_feed_token = fields.Char(copy=False)

    def _get_eva_session_feed_token(self):
        self.ensure_one()
        if not self.eva_session_feed_token:
            self.sudo().eva_session_feed_token = uuid.uuid4().hex
        return self.eva_session_feed_token
