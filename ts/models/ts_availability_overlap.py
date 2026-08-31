from collections import defaultdict

from markupsafe import Markup

from odoo import _, api, fields, models
from odoo.tools import SQL

# Endpoints of the red → green gradient used for `color`, keyed by how much
# of the group is covered (0 members present → all members present).
NOBODY_AVAILABLE_COLOR = (211, 47, 47)  # Material red 700, #D32F2F
EVERYONE_AVAILABLE_COLOR = (46, 125, 50)  # Material green 800, #2E7D32
NO_MEMBERS_COLOR = '#9E9E9E'  # grey fallback for the (practically impossible) 0/0 case
AVAILABILITY_TYPE_ORDER = ['full', 'remote', 'maybe']


class TsAvailabilityOverlap(models.Model):
    _name = 'ts.availability.overlap'
    _description = 'TS Availability Overlap'
    _auto = False
    _order = 'start_datetime'

    start_datetime = fields.Datetime(readonly=True)
    stop_datetime = fields.Datetime(readonly=True)
    covered_members = fields.Integer(string='Members Present', readonly=True)
    total_members = fields.Integer(string='Total Members', readonly=True)
    color = fields.Char(compute='_compute_color')
    attendee_summary = fields.Html(string='Who', compute='_compute_attendee_summary', sanitize=False)

    @api.depends('covered_members', 'total_members')
    def _compute_color(self):
        for overlap in self:
            if not overlap.total_members:
                overlap.color = NO_MEMBERS_COLOR
                continue
            ratio = overlap.covered_members / overlap.total_members
            overlap.color = '#%02X%02X%02X' % tuple(
                round(start + (end - start) * ratio)
                for start, end in zip(NOBODY_AVAILABLE_COLOR, EVERYONE_AVAILABLE_COLOR)
            )

    @api.depends('start_datetime', 'stop_datetime')
    def _compute_attendee_summary(self):
        # An elementary segment is, by construction, either fully inside or
        # fully outside any given availability row's span (see _table_sql),
        # so a plain containment check is enough to know who covers it.
        labels = dict(self.env['ts.availability']._fields['availability_type']._description_selection(self.env))
        members = self.env['res.users'].search([('all_group_ids', 'in', self.env.ref('ts.group_ts_member').id)])
        for overlap in self:
            if not (overlap.start_datetime and overlap.stop_datetime):
                overlap.attendee_summary = False
                continue
            availabilities = self.env['ts.availability'].sudo().search([
                ('start_datetime', '<=', overlap.start_datetime),
                ('stop_datetime', '>=', overlap.stop_datetime),
            ])
            names_by_type = defaultdict(list)
            covered_users = self.env['res.users']
            for availability in availabilities:
                names_by_type[availability.availability_type].append(availability.user_id.name)
                covered_users |= availability.user_id
            lines = []
            for availability_type in AVAILABILITY_TYPE_ORDER:
                names = sorted(names_by_type.get(availability_type, []))
                if names:
                    lines.append(Markup('<b>%s:</b> %s') % (labels.get(availability_type, availability_type), ', '.join(names)))
            absentees = sorted((members - covered_users).mapped('name'))
            if absentees:
                lines.append(Markup('<b>%s:</b> %s') % (_('Absent'), ', '.join(absentees)))
            overlap.attendee_summary = Markup('<br/>').join(lines) if lines else False

    @api.depends('covered_members', 'total_members')
    def _compute_display_name(self):
        for overlap in self:
            overlap.display_name = f'{overlap.covered_members}/{overlap.total_members}'

    @property
    def _table_sql(self):
        administrator_group_id = self.env.ref('ts.group_ts_administrator').id
        member_group_id = self.env.ref('ts.group_ts_member').id
        # Members and administrators are computed here (rather than relying on
        # group implication) because an administrator isn't necessarily also
        # an explicit row of group_ts_member in res_groups_users_rel.
        return SQL("""(
            WITH admins AS (
                SELECT uid AS user_id
                  FROM res_groups_users_rel
                 WHERE gid = %(administrator_group_id)s
            ), explicit_members AS (
                SELECT uid AS user_id
                  FROM res_groups_users_rel
                 WHERE gid = %(member_group_id)s
            ), members AS (
                SELECT user_id FROM explicit_members
                UNION
                SELECT user_id FROM admins
            ), points AS (
                SELECT start_datetime AS t FROM ts_availability
                UNION
                SELECT stop_datetime AS t FROM ts_availability
            ), ordered_points AS (
                SELECT t, lead(t) OVER (ORDER BY t) AS next_t
                  FROM points
            ), segments AS (
                SELECT t AS start_datetime, next_t AS stop_datetime
                  FROM ordered_points
                 WHERE next_t IS NOT NULL AND next_t > t
                   -- Skip pure gaps (no one has recorded anything at all here):
                   -- without this, the segment between the last slot of one day
                   -- and the first slot of a later day would still be emitted,
                   -- as one giant grey block spanning the days in between.
                   AND EXISTS (
                        SELECT 1 FROM ts_availability a
                       WHERE a.start_datetime <= t AND a.stop_datetime >= next_t
                   )
            )
            SELECT
                row_number() OVER (ORDER BY s.start_datetime) AS id,
                s.start_datetime,
                s.stop_datetime,
                (SELECT count(*) FROM members) AS total_members,
                count(DISTINCT a.user_id) FILTER (
                    WHERE a.user_id IN (SELECT user_id FROM members)
                ) AS covered_members
              FROM segments s
              LEFT JOIN ts_availability a
                ON a.availability_type = 'full'
               AND a.start_datetime <= s.start_datetime
               AND a.stop_datetime >= s.stop_datetime
             GROUP BY s.start_datetime, s.stop_datetime
        )""", administrator_group_id=administrator_group_id, member_group_id=member_group_id)
