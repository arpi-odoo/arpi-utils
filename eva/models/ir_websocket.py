from odoo import models

CALL_TRAINING_CHANNEL_PREFIX = 'eva.call.training_'
CALL_TRAINER_MAP_CHANNEL_PREFIX = 'eva.call.trainer.map_'


class IrWebsocket(models.AbstractModel):
    _inherit = 'ir.websocket'

    def _build_bus_channel_list(self, channels):
        """Let the Call Trainer subscribe to live updates of a training (players
        joining, starting, answering) by sending "eva.call.training_<id>", and
        to the open trainings of a map (home page) with "eva.call.trainer.map_<id>"."""
        new_channels = []
        training_ids = []
        map_ids = []
        for channel in channels:
            if isinstance(channel, str) and channel.startswith(CALL_TRAINING_CHANNEL_PREFIX):
                training_id = channel[len(CALL_TRAINING_CHANNEL_PREFIX):]
                if training_id.isdigit():
                    training_ids.append(int(training_id))
            elif isinstance(channel, str) and channel.startswith(CALL_TRAINER_MAP_CHANNEL_PREFIX):
                map_id = channel[len(CALL_TRAINER_MAP_CHANNEL_PREFIX):]
                if map_id.isdigit():
                    map_ids.append(int(map_id))
            else:
                new_channels.append(channel)
        if (training_ids or map_ids) and self.env.user._is_internal():
            if training_ids:
                new_channels.extend(self.env['eva.call.training'].search([('id', 'in', training_ids)]))
            if map_ids:
                new_channels.extend(self.env['eva.map'].search([('id', 'in', map_ids)]))
        return super()._build_bus_channel_list(new_channels)
