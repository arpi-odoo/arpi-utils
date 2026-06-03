import logging

_logger = logging.getLogger(__name__)

GAME_TYPE_WEIGHTS = {
    'league': 35,
    'scrim': 20,
    'classic': 20,
    'zombie': 10,
    'rabbids': 10,
    'other': 5,
}
COMPETITIVE_TYPES = {'league', 'scrim', 'classic'}
DIVISIONS = ['D1', 'D2', 'D3', 'D4']
TEAM_XML_IDS = ['eva.team_ts', 'eva.team_stl', 'eva.team_mou', 'eva.team_ga', 'eva.team_nn']

NUMBER_OF_SESSIONS = 45
DAYS_SPREAD = 90


def post_init_hook(env):
    try:
        env['eva.gg.sync'].cron_import_charleroi_local_league()
    except Exception:
        _logger.exception('eva.gg sync: failed during post_init_hook')
