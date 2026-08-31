from odoo import fields, models


class EvaSessionSubscribeWizard(models.TransientModel):
    _name = 'eva.session.subscribe.wizard'
    _description = 'Subscribe to Sessions Calendar'

    url = fields.Char(readonly=True)

    def default_get(self, fields_list):
        res = super().default_get(fields_list)
        if 'url' in fields_list:
            base_url = self.env['ir.config_parameter'].sudo().get_str('web.base.url')
            token = self.env.user._get_eva_session_feed_token()
            res['url'] = f'{base_url}/eva/sessions/{self.env.user.id}/{token}.ics'
        return res
