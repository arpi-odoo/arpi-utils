
from odoo import models


class TsAvailabilityOverlapFilter(models.Model):
    _name = 'ts.availability.overlap.filter'
    _description = 'TS Best Meeting Times Member Filter'
    _inherit = ['ts.member.filter.mixin']

    _user_id_target_user_id_unique = models.Constraint(
        'UNIQUE(user_id, target_user_id)',
        'You cannot add the same member twice.',
    )
