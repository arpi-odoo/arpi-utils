from datetime import timedelta

from odoo import _, api, fields, models
from odoo.exceptions import ValidationError


class TsWeeklyDisponibilityGenerateWizard(models.TransientModel):
    _name = 'ts.weekly_disponibility.generate.wizard'
    _description = 'Generate Availabilities from Weekly Disponibilities'

    date_from = fields.Date(required=True, default=fields.Date.context_today)
    date_to = fields.Date(required=True, default=lambda self: fields.Date.context_today(self) + timedelta(weeks=4))

    @api.constrains('date_from', 'date_to')
    def _check_dates(self):
        for wizard in self:
            if wizard.date_to <= wizard.date_from:
                raise ValidationError(_('The end date must be after the start date.'))
            if wizard.date_to - wizard.date_from > timedelta(weeks=26):
                raise ValidationError(_('Please generate at most 26 weeks at a time.'))

    def action_generate(self):
        self.ensure_one()
        self.env.user._generate_availabilities_from_weekly_disponibilities(self.date_from, self.date_to)
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': _('Availabilities Generated'),
                'message': _('Your availabilities have been generated from your weekly disponibilities.'),
                'type': 'success',
            },
        }
