
{
    'name': 'EVA',
    'category': 'E-Sport/EVA',
    'sequence': 292,
    'summary': 'Module to handle all EVA related matters',
    'depends': [
        'resource_mail',
        'website',
    ],
    'external_dependencies': {
        'python': ['requests'],
    },
    'data': [
        'security/ir.access.csv',
        'views/eva_session_views.xml',
        'views/eva_session_matchup_views.xml',
        'views/eva_map_views.xml',
        'views/eva_player_views.xml',
        'views/eva_game_views.xml',
        'views/eva_game_result_views.xml',
        'views/eva_team_views.xml',
        'views/eva_token_move_views.xml',
        'views/eva_views.xml',
        'views/eva_website_templates.xml',
        'data/eva_map_data.xml',
        'data/ir_cron_data.xml',
    ],
    'post_init_hook': 'post_init_hook',
    'application': True,
    'assets': {
        'web.assets_backend': [
            'eva/static/src/**/*',
            # The graph view (Chart.js) itself lives in the lazy-loaded bundle below,
            # not in assets_backend, so anything extending it must move there too.
            ('remove', 'eva/static/src/views/eva_game_result_graph/**/*'),
        ],
        'web.assets_backend_lazy': [
            'eva/static/src/views/eva_game_result_graph/**/*',
        ],
    },
    'author': 'Arthur Pierrot',
    'license': 'LGPL-3',
}
