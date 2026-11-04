from odoo import models

CALL_TRAINING_CHANNEL_PREFIX = 'eva.call.training_'


class IrWebsocket(models.AbstractModel):
    _inherit = 'ir.websocket'

    def _build_bus_channel_list(self, channels):
        """Let the Call Trainer subscribe to live updates of a training (players
        joining, starting, answering) by sending "eva.call.training_<id>"."""
        new_channels = []
        training_ids = []
        for channel in channels:
            if isinstance(channel, str) and channel.startswith(CALL_TRAINING_CHANNEL_PREFIX):
                training_id = channel[len(CALL_TRAINING_CHANNEL_PREFIX):]
                if training_id.isdigit():
                    training_ids.append(int(training_id))
            else:
                new_channels.append(channel)
        if training_ids and self.env.user._is_internal():
            new_channels.extend(self.env['eva.call.training'].search([('id', 'in', training_ids)]))
        return super()._build_bus_channel_list(new_channels)
