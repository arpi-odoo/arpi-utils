
from odoo import fields, models


class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'

    ts_meeting_reminder_days = fields.Integer(
        string='Days Before Meeting to Send a Reminder',
        default=3,
        config_parameter='ts.meeting_reminder_days',
    )
