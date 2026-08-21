
from itertools import permutations

from odoo import api, fields, models


class TsAvailabilityFilter(models.Model):
    _name = 'ts.availability.filter'
    _description = 'TS Availability Calendar Filter'

    user_id = fields.Many2one(
        'res.users', string='Me', required=True, index=True,
        default=lambda self: self.env.user, ondelete='cascade')
    target_user_id = fields.Many2one('res.users', string='Member', required=True, index=True)
    active = fields.Boolean(default=True)
    checked = fields.Boolean(default=True)

    _user_id_target_user_id_unique = models.Constraint(
        'UNIQUE(user_id, target_user_id)',
        'You cannot add the same member twice.',
    )

    @api.model
    def _sync_all_member_filters(self):
        """Make every effective member/administrator show up by default in
        everyone else's Availabilities calendar sidebar, without anyone
        having to manually "+ Add User" their colleagues one by one."""
        members = self.env['res.users'].search([
            ('all_group_ids', 'in', self.env.ref('ts.group_ts_member').id),
        ])
        existing_pairs = set(self.sudo().search([
            ('user_id', 'in', members.ids), ('target_user_id', 'in', members.ids),
        ]).mapped(lambda f: (f.user_id.id, f.target_user_id.id)))
        to_create = [
            {'user_id': viewer_id, 'target_user_id': target_id}
            for viewer_id, target_id in permutations(members.ids, 2)
            if (viewer_id, target_id) not in existing_pairs
        ]
        if to_create:
            self.sudo().create(to_create)
