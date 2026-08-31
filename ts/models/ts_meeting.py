
import re
from datetime import datetime, time, timedelta
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

from dateutil.relativedelta import relativedelta

from odoo import _, api, fields, models
from odoo.tools import html2plaintext, is_html_empty

try:
    import vobject
except ImportError:
    vobject = None


def _agenda_to_plaintext(agenda_html):
    """ html2plaintext() only turns `</p>`, `<tr>` and `<br>` tags into newlines,
    so a bullet/numbered list (a very common shape for a meeting agenda) was
    collapsing into a single space-separated line: give it explicit <br/>
    tags around each list item, which it already knows how to break on.
    """
    agenda_html = re.sub(r'<li[^>]*>', '<br/>- ', agenda_html)
    agenda_html = agenda_html.replace('</li>', '<br/>')
    return html2plaintext(agenda_html)


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
    has_minutes = fields.Boolean(compute='_compute_has_minutes')
    participant_ids = fields.Many2many('res.users', string='Participants')

    @api.depends('date', 'duration')
    def _compute_date_end(self):
        for meeting in self:
            meeting.date_end = meeting.date and meeting.date + timedelta(hours=meeting.duration)

    @api.depends('minutes')
    def _compute_has_minutes(self):
        for meeting in self:
            meeting.has_minutes = not is_html_empty(meeting.minutes)

    def _send_template_to_participants(self, template):
        """ Send 'template' once per participant, each rendered in that
            participant's own language, rather than one shared email
            rendered in the language of the user triggering the send.
        """
        sent_count = 0
        failures = []
        for meeting in self:
            for participant in meeting.participant_ids:
                if not participant.partner_id:
                    continue
                mail_id = template.with_context(lang=participant.lang).send_mail(
                    meeting.id, force_send=True,
                    email_values={'recipient_ids': [(6, 0, [participant.partner_id.id])]},
                )
                mail = self.env['mail.mail'].sudo().browse(mail_id).exists()
                if not mail or mail.state == 'sent':
                    sent_count += 1
                else:
                    failures.append(_(
                        '%(meeting)s / %(participant)s: %(reason)s',
                        meeting=meeting.name,
                        participant=participant.name,
                        reason=mail.failure_reason or mail.state,
                    ))
        return sent_count, failures

    def action_send_reminder_email(self):
        template = self.env.ref('ts.mail_template_meeting_reminder')
        sent_count, failures = self._send_template_to_participants(template)

        if failures:
            message = _(
                '%(sent_count)s email(s) sent, %(failed_count)s failed:\n%(details)s',
                sent_count=sent_count, failed_count=len(failures), details='\n'.join(failures),
            )
            notification_type = 'danger'
        else:
            message = _('%(count)s email(s) sent successfully.', count=sent_count)
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
        sent_count, failures = self._send_template_to_participants(template)

        if failures:
            message = _(
                '%(sent_count)s email(s) sent, %(failed_count)s failed:\n%(details)s',
                sent_count=sent_count, failed_count=len(failures), details='\n'.join(failures),
            )
            notification_type = 'danger'
        else:
            message = _('%(count)s email(s) sent successfully.', count=sent_count)
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
                description = _agenda_to_plaintext(meeting.agenda)
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
