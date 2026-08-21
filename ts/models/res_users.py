from odoo import api, models


class ResUsers(models.Model):
    _inherit = 'res.users'

    @api.model_create_multi
    def create(self, vals_list):
        users = super().create(vals_list)
        if any('group_ids' in vals for vals in vals_list):
            self.env['ts.availability.filter']._sync_all_member_filters()
        return users

    def write(self, vals):
        result = super().write(vals)
        if 'group_ids' in vals:
            self.env['ts.availability.filter']._sync_all_member_filters()
        return result
