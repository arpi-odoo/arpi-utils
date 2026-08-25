import logging
import re
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

import requests

from odoo import models

_logger = logging.getLogger(__name__)

API_BASE_URL = 'https://competitive.eva.gg/api'
REQUEST_TIMEOUT = 20
USER_AGENT = 'Odoo-EVA-Sync/1.0 (internal club tool; contact: arpi-utils)'

# Charleroi local league, all divisions. To widen the import further, add
# region ids here.
CHARLEROI_REGION_ID = '2408110785608632319'
# Matches eva.session's 'division' selection (D1-D4); anything outside this is
# some other competition format and is skipped rather than crashing the cron.
VALID_DIVISION_NUMBERS = {1, 2, 3, 4}

# Players commonly name themselves "<TEAM TAG>x<username>" (e.g. "TSxBk", "C4SxAngess");
# the run before the 'x' is the team's actual short name, not the username. Tags can
# include digits (e.g. "C4S"), so long as they start with a letter (to avoid matching
# a username that merely happens to contain an 'x', e.g. "Rivox").
TAGGED_USERNAME_RE = re.compile(r'^([A-Z][A-Z0-9]*)x(.+)$')


class EvaGgSync(models.Model):
    _name = 'eva.gg.sync'
    _description = 'EVA.gg Competitive API Sync'

    def _request(self, path, params=None):
        response = requests.get(
            f'{API_BASE_URL}/{path}',
            params=params or {},
            headers={'User-Agent': USER_AGENT},
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
        return response.json()

    @staticmethod
    def _normalize(value):
        return ''.join(char.lower() for char in (value or '') if char.isalnum())

    @staticmethod
    def _short_name(name):
        words = name.split()
        initials = ''.join(word[0] for word in words) if len(words) > 1 else name
        return initials[:4].upper()

    def _find_team(self, participant):
        Team = self.env['eva.team']
        remote_id = (participant.get('team') or {}).get('id')
        name = participant.get('name')
        if not remote_id or not name:
            # No stable id to key off (e.g. a bye/TBD placeholder opponent): can't
            # safely match or create a team, so let the caller skip this match.
            _logger.warning('eva.gg sync: participant has no team id or name: %r', participant)
            return Team.browse()

        team = Team.search([('eva_gg_id', '=', remote_id)], limit=1)
        if not team:
            # Remote names can differ from ours in spacing/casing (e.g. "TacticalStrike"
            # vs "Tactical Strike"), so compare normalized (alphanumeric, lowercase) forms.
            target = self._normalize(name)
            for candidate in Team.search([]):
                if target in (self._normalize(candidate.name), self._normalize(candidate.short_name)):
                    candidate.eva_gg_id = remote_id
                    team = candidate
                    break

        if not team:
            team = Team.create({
                'name': name,
                'short_name': self._short_name(name),
                'eva_gg_id': remote_id,
            })
            _logger.info(
                'eva.gg sync: created new eva.team %r (%s) for eva.gg team %s', name, team.short_name, remote_id)

        self._sync_lineup(team, remote_id)
        return team

    def _sync_lineup(self, team, remote_team_id):
        try:
            members = self._request(f'teams/{remote_team_id}/members')
        except requests.RequestException:
            _logger.exception('eva.gg sync: failed to fetch lineup for team %s', remote_team_id)
            return

        Player = self.env['eva.player']
        tag_votes = Counter()
        for member in members:
            player_user = member.get('playerUser') or {}
            remote_player_id = player_user.get('id')
            raw_name = player_user.get('name')
            if not remote_player_id or not raw_name:
                continue

            tag_match = TAGGED_USERNAME_RE.match(raw_name)
            if tag_match:
                tag_votes[tag_match.group(1)] += 1
                username = tag_match.group(2)
            else:
                username = raw_name

            player = Player.search([('eva_gg_id', '=', remote_player_id)], limit=1)
            if not player:
                # A player can already exist locally (a real club member with a user
                # account) before ever being linked to their eva.gg id; only look for
                # a name match within this team, not the whole player base.
                target = self._normalize(username)
                for candidate in team.player_ids:
                    if target == self._normalize(candidate.name):
                        candidate.eva_gg_id = remote_player_id
                        player = candidate
                        break

            if not player:
                # No user_id is set here: these players are scraped stand-ins, not
                # real club members, so no res.users account is created for them.
                player = Player.create({
                    'name': username,
                    'team_id': team.id,
                    'eva_gg_id': remote_player_id,
                })
                _logger.info(
                    'eva.gg sync: created new eva.player %r for eva.gg player %s', username, remote_player_id)
            else:
                values = {}
                if player.team_id != team:
                    values['team_id'] = team.id
                # Only keep the derived username in sync for scraped stand-ins; a
                # real club member's display name is theirs to manage, not ours to
                # overwrite from eva.gg capitalization/formatting.
                if not player.user_id and player.name != username:
                    values['name'] = username
                if values:
                    player.write(values)

        if tag_votes:
            # Use the tag most players actually play under, not the guess made (from
            # the team's display name) when the team was first created.
            detected_short_name = tag_votes.most_common(1)[0][0]
            if team.short_name != detected_short_name:
                team.short_name = detected_short_name

    def _find_map(self, machine_name):
        if not machine_name:
            return self.env['eva.map'].browse()
        Map = self.env['eva.map']
        map_record = Map.search([('eva_gg_id', '=', machine_name)], limit=1)
        if map_record:
            return map_record

        guess = machine_name.replace('_', ' ').title()
        map_record = Map.search([('name', '=ilike', guess)], limit=1)
        if map_record:
            map_record.eva_gg_id = machine_name
            return map_record

        map_record = Map.create({
            'name': guess,
            'eva_gg_id': machine_name,
        })
        _logger.info('eva.gg sync: created new eva.map %r for eva.gg map %s', guess, machine_name)
        return map_record

    @staticmethod
    def _to_utc_naive(iso_datetime):
        value = datetime.fromisoformat(iso_datetime)
        if value.tzinfo:
            value = value.astimezone(timezone.utc).replace(tzinfo=None)
        return value

    # Session state only ever moves forward through here, and never past 'cancelled'
    # (a user-cancelled session is left alone regardless of what eva.gg says).
    _STATE_ORDER = {'draft': 0, 'confirmed': 1, 'done': 2}

    def _get_or_create_session(self, session_key, division_number, play_date, day_matches):
        Session = self.env['eva.session']
        state = 'done' if all(m['status'] == 'completed' for m in day_matches) else 'confirmed'

        session = Session.search([('eva_gg_session_key', '=', session_key)], limit=1)
        if session:
            # Flip a session from 'confirmed' to 'done' once its last outstanding fixture
            # is played; never touch it otherwise (e.g. a user-cancelled session).
            if session.state == 'confirmed' and state == 'done':
                session.state = 'done'
            return session

        earliest = min(self._to_utc_naive(m['scheduledDatetime']) for m in day_matches)

        # Adopt a session someone created by hand before this fixture existed on eva.gg,
        # instead of creating a duplicate: same day (not hour, since a manual entry's time
        # is a guess), same game type and division, not yet linked to any eva.gg session.
        # A cancelled one is excluded entirely, not just left at its current state: it
        # should never be re-linked or re-timed either (same "never touch it" rule as
        # for an already-linked session above).
        day_start = datetime.combine(play_date, datetime.min.time())
        manual_session = Session.search([
            ('eva_gg_session_key', '=', False),
            ('state', '!=', 'cancelled'),
            ('type', '=', 'league'),
            ('division', '=', f'D{division_number}'),
            ('datetime', '>=', day_start),
            ('datetime', '<', day_start + timedelta(days=1)),
        ], limit=1)
        if manual_session:
            # Update the datetime first, in its own write: eva.session._check_state_transition
            # reads session.datetime against the *pre-write* value, so bundling a 'done'
            # promotion into the same write as the datetime fix would wrongly check it
            # against the old, manually-guessed time instead of the real eva.gg schedule.
            manual_session.write({'eva_gg_session_key': session_key, 'datetime': earliest})
            if self._STATE_ORDER[manual_session.state] < self._STATE_ORDER[state]:
                manual_session.state = state
            return manual_session

        return Session.create({
            'eva_gg_session_key': session_key,
            'datetime': earliest,
            'state': state,
            'type': 'league',
            'division': f'D{division_number}',
        })

    def _import_match(self, match_summary, session):
        match_id = match_summary['id']
        # Keyed per-map rather than per-match: a map can be missing locally (and get
        # created only later, e.g. via _find_map) while the rest of the match's maps
        # already got imported, so a match-level check would permanently skip it.
        imported_map_ids = set(self.env['eva.game'].search(
            [('eva_gg_match_id', '=', match_id)]).map_id.ids)

        detail = self._request(f'matches/{match_id}')
        opponents = detail['opponents']
        team_1 = self._find_team(opponents[0]['participant'])
        team_2 = self._find_team(opponents[1]['participant'])
        if not team_1 or not team_2:
            _logger.warning('eva.gg sync: skipping match %s, could not resolve both teams', match_id)
            return

        created = 0
        for match_set in detail['matchSets']:
            map_record = self._find_map(match_set['properties'].get('map'))
            if not map_record or map_record.id in imported_map_ids:
                continue
            winner_number = next(
                (opponent['number'] for opponent in match_set['opponents'] if opponent['result'] == 'win'), None)
            winner = team_1 if winner_number == 1 else team_2 if winner_number == 2 else self.env['eva.team'].browse()
            self.env['eva.game'].create({
                'session_id': session.id,
                'map_id': map_record.id,
                'team_1_id': team_1.id,
                'team_2_id': team_2.id,
                'winner': winner.id,
                'eva_gg_match_id': match_id,
            })
            created += 1

        if created:
            _logger.info(
                'eva.gg sync: imported match %s into session %s (%s games)', match_id, session.id, created)

    def _import_tournament(self, tournament_id):
        # No 'statuses' filter: this pulls both already-played ('completed') and
        # upcoming ('pending') fixtures, so future sessions get created ahead of time.
        matches = self._request('matches', params={
            'tournament_ids': tournament_id,
            'sort': 'scheduled_asc',
            'offset': 0,
            'limit': 100,
        })
        relevant = [
            match_summary for match_summary in matches['items']
            # Some never-played fixtures in a since-completed tournament (e.g. a
            # playoff round that never happened) carry no schedule at all; skip them.
            if match_summary.get('scheduledDatetime')
            and (match_summary.get('group') or {}).get('number') in VALID_DIVISION_NUMBERS
        ]
        # Group same-day fixtures of the same division into a single session, keyed
        # by the day they were actually scheduled to be played (not when results
        # happened to be entered, which can lag behind by several days). Grouping is
        # done on the full (pending + completed) set so a session's state reflects
        # whether the whole day's fixtures are done, not just the newly-imported ones.
        by_day = defaultdict(list)
        for match_summary in relevant:
            division_number = match_summary['group']['number']
            play_date = self._to_utc_naive(match_summary['scheduledDatetime']).date()
            by_day[(division_number, play_date)].append(match_summary)

        for (division_number, play_date), day_matches in by_day.items():
            session_key = f'{tournament_id}:{division_number}:{play_date.isoformat()}'
            session = self._get_or_create_session(session_key, division_number, play_date, day_matches)
            for match_summary in day_matches:
                if match_summary['status'] == 'completed':
                    self._import_match(match_summary, session)
            self._sync_session_players(session)

    def _sync_session_players(self, session):
        teams = session.game_ids.team_1_id | session.game_ids.team_2_id
        players = teams.player_ids
        if players and session.player_ids != players:
            session.player_ids = players

    def cron_import_charleroi_local_league(self):
        try:
            tournaments = self._request('tournaments', params={
                'circuit_region_ids': CHARLEROI_REGION_ID,
                'limit': 20,
            })
        except requests.RequestException:
            _logger.exception('eva.gg sync: failed to fetch tournament list')
            return

        # 'completed' tournaments are included too, to backfill past sessions/games;
        # 'pending' tournaments are skipped since they don't have matches yet.
        relevant_tournament_ids = [t['id'] for t in tournaments['items'] if t['status'] in ('running', 'completed')]
        for tournament_id in relevant_tournament_ids:
            try:
                self._import_tournament(tournament_id)
            except requests.RequestException:
                _logger.exception('eva.gg sync: failed to import tournament %s', tournament_id)
