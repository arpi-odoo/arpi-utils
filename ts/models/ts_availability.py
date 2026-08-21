
from odoo import _, api, fields, models
from odoo.exceptions import ValidationError

AVAILABILITY_COLORS = {
    'full': '#2E7D32',
    'remote': '#1565C0',
    'maybe': '#9E9E9E',
}


class TsAvailability(models.Model):
    _name = 'ts.availability'
    _description = 'TS Availability'
    _order = 'start_datetime'

    user_id = fields.Many2one(
        'res.users', string='User', required=True, index=True,
        default=lambda self: self.env.user)
    start_datetime = fields.Datetime(string='Start', required=True)
    stop_datetime = fields.Datetime(string='End', required=True)
    availability_type = fields.Selection([
        ('full', 'Available'),
        ('remote', 'Remote'),
        ('maybe', 'Maybe'),
    ], string='Availability', required=True, default='full')
    color = fields.Char(compute='_compute_color')

    @api.depends('availability_type')
    def _compute_color(self):
        for availability in self:
            availability.color = AVAILABILITY_COLORS.get(availability.availability_type, AVAILABILITY_COLORS['maybe'])

    @api.depends('user_id', 'availability_type')
    def _compute_display_name(self):
        labels = dict(self._fields['availability_type']._description_selection(self.env))
        for availability in self:
            availability.display_name = "%s (%s)" % (
                availability.user_id.name, labels.get(availability.availability_type))

    @api.constrains('start_datetime', 'stop_datetime')
    def _check_dates(self):
        for availability in self:
            if availability.stop_datetime <= availability.start_datetime:
                raise ValidationError(_('The end of an availability must be after its start.'))
