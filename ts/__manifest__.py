
{
    'name': 'TS',
    'category': 'Association',
    'summary': 'Module to manage Tactical Strike (ASBL)',
    'depends': [
        'base',
        'documents',
        'mail',
    ],
    'data': [
        'security/ts_security.xml',
        'security/ir.access.csv',
        'data/mail_template_data.xml',
        'data/ir_cron_data.xml',
        'data/ts_data.xml',
        'views/ts_meeting_views.xml',
        'views/ts_meeting_subscribe_wizard_views.xml',
        'views/ts_availability_views.xml',
        'views/ts_availability_overlap_views.xml',
        'views/res_config_settings_views.xml',
    ],
    'assets': {
        'web.assets_backend': [
            'ts/static/src/**/*',
        ],
    },
    'post_init_hook': 'post_init_hook',
    'application': True,
    'author': 'Arthur Pierrot',
    'license': 'LGPL-3',
}
