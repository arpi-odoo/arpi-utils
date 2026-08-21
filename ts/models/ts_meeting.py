
from datetime import datetime, time, timedelta

from dateutil.relativedelta import relativedelta

from odoo import _, api, fields, models


class TsMeeting(models.Model):
    _name = 'ts.meeting'
    _description = 'TS Meeting'
    _order = 'date desc'

    name = fields.Char(required=True)
    date = fields.Datetime(required=True, default=fields.Datetime.now)
    agenda = fields.Html()
    minutes = fields.Html(string='Meeting Minutes')
    participant_ids = fields.Many2many('res.users', string='Participants')

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

    @api.model
    def _cron_send_meeting_reminders(self):
        reminder_days = self.env['ir.config_parameter'].sudo().get_int('ts.meeting_reminder_days', 3)
        target_date = fields.Date.context_today(self) + relativedelta(days=reminder_days)
        target_start = datetime.combine(target_date, time.min)
        target_end = target_start + timedelta(days=1)
        meetings = self.search([('date', '>=', target_start), ('date', '<', target_end)])
        meetings.action_send_reminder_email()
