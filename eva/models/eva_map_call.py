import re
import unicodedata

from odoo import api, fields, models


def normalize_call(text):
    """Lowercase, strip accents and drop everything that isn't a letter or a
    digit, so that "Mid Door", "mid-door" and "MIDDOOR" all compare equal."""
    text = unicodedata.normalize('NFKD', text or '')
    text = ''.join(c for c in text if not unicodedata.combining(c))
    return re.sub(r'[^a-z0-9]', '', text.lower())


def typo_distance(a, b):
    """Optimal string alignment distance: Levenshtein (insert, delete,
    substitute) plus transposition of two adjacent characters ("tpo" -> "top")."""
    if a == b:
        return 0
    if not a or not b:
        return len(a) or len(b)
    previous_previous = None
    previous = list(range(len(b) + 1))
    for i, char_a in enumerate(a, 1):
        current = [i] + [0] * len(b)
        for j, char_b in enumerate(b, 1):
            cost = char_a != char_b
            current[j] = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
            if (i > 1 and j > 1 and char_a == b[j - 2] and a[i - 2] == char_b):
                current[j] = min(current[j], previous_previous[j - 2] + 1)
        previous_previous, previous = previous, current
    return previous[-1]


def allowed_typos(normalized):
    """How many typos are tolerated for a (normalized) call name."""
    length = len(normalized)
    if length <= 2:
        return 0
    if length <= 5:
        return 1
    if length <= 9:
        return 2
    return 3


class EvaMapCall(models.Model):
    _name = 'eva.map.call'
    _description = 'EVA Map Call'
    _order = 'map_id, sequence, name'

    name = fields.Char(required=True)
    sequence = fields.Integer(default=10)
    active = fields.Boolean(default=True)
    map_id = fields.Many2one('eva.map', required=True, index=True, ondelete='cascade')
    aliases = fields.Char(help='Other accepted names for this call, separated by commas (e.g. "Middle Door, MD").')
    image_ids = fields.One2many('eva.map.call.image', 'call_id', string='Images')
    image_count = fields.Integer(compute='_compute_image_count')
    cover_image = fields.Image(compute='_compute_cover_image')
    answer_ids = fields.One2many('eva.call.training.answer', 'call_id')

    @api.depends('image_ids')
    def _compute_image_count(self):
        for call in self:
            call.image_count = len(call.image_ids)

    @api.depends('image_ids.image')
    def _compute_cover_image(self):
        for call in self:
            call.cover_image = call.image_ids[:1].image_512

    def _get_accepted_names(self):
        self.ensure_one()
        names = [self.name] + (self.aliases or '').split(',')
        return {normalized for normalized in map(normalize_call, names) if normalized}

    def _is_answer_correct(self, answer):
        """Whether ``answer`` names this call, allowing small typos, case and
        accents differences. A typo'ed answer is only accepted if it isn't at
        least as close to another call of the same map, so that "Bot" never
        counts as "Box" when both exist."""
        self.ensure_one()
        answer = normalize_call(answer)
        if not answer:
            return False
        accepted_names = self._get_accepted_names()
        if answer in accepted_names:
            return True

        close_distances = [
            distance for name in accepted_names
            if (distance := typo_distance(answer, name)) <= allowed_typos(name)
        ]
        if not close_distances:
            return False
        distance = min(close_distances)
        other_calls = self.with_context(active_test=False).search([
            ('map_id', '=', self.map_id.id), ('id', '!=', self.id),
        ])
        for other_call in other_calls:
            other_names = other_call._get_accepted_names()
            if other_names and min(typo_distance(answer, name) for name in other_names) <= distance:
                return False
        return True

    def action_open_answers(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': self.env._('Answers for %s', self.name),
            'res_model': 'eva.call.training.answer',
            'view_mode': 'graph,pivot,list',
            'domain': [('call_id', '=', self.id)],
            'context': {'search_default_mine': 1, 'search_default_group_by_week': 1},
        }


class EvaMapCallImage(models.Model):
    _name = 'eva.map.call.image'
    _description = 'EVA Map Call Image'
    _order = 'sequence, id'

    sequence = fields.Integer(default=10)
    call_id = fields.Many2one('eva.map.call', required=True, index=True, ondelete='cascade')
    map_id = fields.Many2one(related='call_id.map_id', store=True)
    image = fields.Image(required=True, max_width=1920, max_height=1920)
    image_512 = fields.Image('Thumbnail', related='image', max_width=512, max_height=512, store=True)
