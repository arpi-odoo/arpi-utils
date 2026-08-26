
from datetime import datetime, time, timedelta
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

from dateutil.relativedelta import relativedelta

from odoo import _, api, fields, models
from odoo.tools import html2plaintext

try:
    import vobject
except ImportError:
    vobject = None


class TsMeeting(models.Model):
    _name = 'ts.meeting'
    _description = 'TS Meeting'
    _order = 'date desc'

    name = fields.Char(required=True)
    date = fields.Datetime(required=True, default=fields.Datetime.now)
    duration = fields.Float(default=1.0, help="Duration in hours")
    date_end = fields.Datetime(compute='_compute_date_end', store=True)
    agenda = fields.Html()
    minutes = fields.Html(string='Meeting Minutes')
    participant_ids = fields.Many2many('res.users', string='Participants')

    @api.depends('date', 'duration')
    def _compute_date_end(self):
        for meeting in self:
            meeting.date_end = meeting.date and meeting.date + timedelta(hours=meeting.duration)

    def action_send_reminder_email(self):
        template = self.env.ref('ts.mail_template_meeting_reminder')
        sent_meetings = self.browse()
        failures = []
        for meeting in self:
            if not meeting.participant_ids:
                continue
            mail_id = template.send_mail(meeting.id, force_send=True)
            mail = self.env['mail.mail'].sudo().browse(mail_id)
            if mail.state == 'sent':
                sent_meetings += meeting
            else:
                failures.append(_(
                    '%(meeting)s: %(reason)s',
                    meeting=meeting.name,
                    reason=mail.failure_reason or mail.state,
                ))

        if failures:
            message = _(
                '%(sent_count)s reminder email(s) sent, %(failed_count)s failed:\n%(details)s',
                sent_count=len(sent_meetings), failed_count=len(failures), details='\n'.join(failures),
            )
            notification_type = 'danger'
        else:
            message = _('%(count)s reminder email(s) sent successfully.', count=len(sent_meetings))
            notification_type = 'success'

        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': _('Meeting Reminder'),
                'message': message,
                'type': notification_type,
                'sticky': bool(failures),
            },
        }

    def action_send_minutes_email(self):
        template = self.env.ref('ts.mail_template_meeting_minutes')
        sent_meetings = self.browse()
        failures = []
        for meeting in self:
            if not meeting.participant_ids:
                continue
            mail_id = template.send_mail(meeting.id, force_send=True)
            mail = self.env['mail.mail'].sudo().browse(mail_id)
            if mail.state == 'sent':
                sent_meetings += meeting
            else:
                failures.append(_(
                    '%(meeting)s: %(reason)s',
                    meeting=meeting.name,
                    reason=mail.failure_reason or mail.state,
                ))

        if failures:
            message = _(
                '%(sent_count)s meeting minutes email(s) sent, %(failed_count)s failed:\n%(details)s',
                sent_count=len(sent_meetings), failed_count=len(failures), details='\n'.join(failures),
            )
            notification_type = 'danger'
        else:
            message = _('%(count)s meeting minutes email(s) sent successfully.', count=len(sent_meetings))
            notification_type = 'success'

        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': _('Meeting Minutes'),
                'message': message,
                'type': notification_type,
                'sticky': bool(failures),
            },
        }

    def _get_ics_feed(self):
        """ Return a single iCalendar file (bytes) listing all meetings in self,
            meant to be served as a subscribable feed (see the ts.controllers.main
            /ts/meetings/<uid>/<token>.ics route).
        """
        if not vobject:
            return b''

        base_url = self.env['ir.config_parameter'].sudo().get_str('web.base.url')
        uid_host = urlparse(base_url).hostname or 'tacticalstrike'

        cal = vobject.iCalendar()
        cal.add('x-wr-calname').value = _('Tactical Strike Meetings')
        cal.add('method').value = 'PUBLISH'

        for meeting in self:
            event = cal.add('vevent')
            event.add('uid').value = f'ts-meeting-{meeting.id}@{uid_host}'
            event.add('dtstamp').value = fields.Datetime.now().replace(tzinfo=ZoneInfo('UTC'))
            event.add('dtstart').value = meeting.date.replace(tzinfo=ZoneInfo('UTC'))
            event.add('dtend').value = meeting.date_end.replace(tzinfo=ZoneInfo('UTC'))
            event.add('summary').value = meeting.name
            if meeting.agenda:
                description = html2plaintext(meeting.agenda)
                if description:
                    event.add('description').value = description
            for participant in meeting.participant_ids:
                if participant.email:
                    attendee = event.add('attendee')
                    attendee.value = f'MAILTO:{participant.email}'
                    attendee.params['CN'] = [participant.name.replace('"', "'")]

        return cal.serialize().encode('utf-8')

    @api.model
    def _cron_send_meeting_reminders(self):
        reminder_days = self.env['ir.config_parameter'].sudo().get_int('ts.meeting_reminder_days', 3)
        target_date = fields.Date.context_today(self) + relativedelta(days=reminder_days)
        target_start = datetime.combine(target_date, time.min)
        target_end = target_start + timedelta(days=1)
        meetings = self.search([('date', '>=', target_start), ('date', '<', target_end)])
        meetings.action_send_reminder_email()
