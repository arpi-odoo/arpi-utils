from odoo import fields, models


class TsMeetingSubscribeWizard(models.TransientModel):
    _name = 'ts.meeting.subscribe.wizard'
    _description = 'Subscribe to Meetings Calendar'

    url = fields.Char(readonly=True)

    def default_get(self, fields_list):
        res = super().default_get(fields_list)
        if 'url' in fields_list:
            base_url = self.env['ir.config_parameter'].sudo().get_str('web.base.url')
            token = self.env.user._get_ts_meeting_feed_token()
            res['url'] = f'{base_url}/ts/meetings/{self.env.user.id}/{token}.ics'
        return res
