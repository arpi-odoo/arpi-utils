import uuid
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from odoo import api, fields, models


class ResUsers(models.Model):
    _inherit = 'res.users'

    ts_meeting_feed_token = fields.Char(copy=False)
    weekly_disponibility_ids = fields.One2many(
        'ts.weekly_disponibility', 'user_id', string='Weekly Disponibilities', user_writeable=True)

    @api.model
    def action_generate_availabilities_from_weekly_disponibilities(self, date_from, date_to):
        """ RPC-callable wrapper: generate for the current user from plain
            ISO date strings, e.g. called from the availability calendar view.
        """
        self.env.user._generate_availabilities_from_weekly_disponibilities(
            fields.Date.to_date(date_from), fields.Date.to_date(date_to))

    def _generate_availabilities_from_weekly_disponibilities(self, date_from, date_to):
        """ (Re)generate ts.availability records from weekly_disponibility_ids
            for every day in [date_from, date_to). Previously generated
            availabilities in that range are replaced; manually created ones
            are left untouched.
        """
        Availability = self.env['ts.availability']
        for user in self:
            tz = ZoneInfo(user.tz or 'UTC')
            self.env['ts.availability'].search([
                ('user_id', '=', user.id),
                ('weekly_disponibility_id', '!=', False),
                ('start_datetime', '>=', date_from),
                ('start_datetime', '<', date_to),
            ]).unlink()

            vals_list = []
            day = date_from
            while day < date_to:
                weekday = str(day.weekday())
                for disponibility in user.weekly_disponibility_ids.filtered(lambda d: d.weekday == weekday):
                    vals_list.append({
                        'user_id': user.id,
                        'weekly_disponibility_id': disponibility.id,
                        'start_datetime': self._ts_local_hour_to_utc(day, disponibility.start_hour, tz),
                        'stop_datetime': self._ts_local_hour_to_utc(day, disponibility.stop_hour, tz),
                        'availability_type': disponibility.availability_type,
                    })
                day += timedelta(days=1)
            Availability.create(vals_list)

    @api.model
    def _ts_local_hour_to_utc(self, day, hour, tz):
        local_dt = datetime.combine(day, time.min, tzinfo=tz) + timedelta(hours=hour)
        return local_dt.astimezone(ZoneInfo('UTC')).replace(tzinfo=None)

    def _get_ts_meeting_feed_token(self):
        self.ensure_one()
        if not self.ts_meeting_feed_token:
            self.sudo().ts_meeting_feed_token = uuid.uuid4().hex
        return self.ts_meeting_feed_token

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
