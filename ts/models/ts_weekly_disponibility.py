
from odoo import _, api, fields, models
from odoo.exceptions import ValidationError

from .ts_availability import AVAILABILITY_COLORS, AVAILABILITY_TYPES

WEEKDAYS = [
    ('0', 'Monday'),
    ('1', 'Tuesday'),
    ('2', 'Wednesday'),
    ('3', 'Thursday'),
    ('4', 'Friday'),
    ('5', 'Saturday'),
    ('6', 'Sunday'),
]


class TsWeeklyDisponibility(models.Model):
    _name = 'ts.weekly_disponibility'
    _description = 'TS Weekly Disponibility'
    _order = 'weekday, start_hour'

    user_id = fields.Many2one(
        'res.users', string='User', required=True, index=True,
        default=lambda self: self.env.user, ondelete='cascade')
    weekday = fields.Selection(WEEKDAYS, required=True, default='0')
    start_hour = fields.Float(string='Start', required=True, default=18.0)
    stop_hour = fields.Float(string='End', required=True, default=22.0)
    availability_type = fields.Selection(AVAILABILITY_TYPES, string='Availability', required=True, default='full')
    color = fields.Char(compute='_compute_color')

    @api.depends('availability_type')
    def _compute_color(self):
        for disponibility in self:
            disponibility.color = AVAILABILITY_COLORS.get(disponibility.availability_type, AVAILABILITY_COLORS['maybe'])

    @api.constrains('start_hour', 'stop_hour')
    def _check_hours(self):
        for disponibility in self:
            if disponibility.stop_hour <= disponibility.start_hour:
                raise ValidationError(_('The end of a weekly disponibility must be after its start.'))
            if not (0 <= disponibility.start_hour < 24) or not (0 < disponibility.stop_hour <= 24):
                raise ValidationError(_('Hours must be between 0:00 and 24:00.'))
