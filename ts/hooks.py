import logging

_logger = logging.getLogger(__name__)


def post_init_hook(env):
    try:
        # Documents ships these as regular (non-demo) data with noupdate="1", so
        # they always get created on install and never get restored afterwards:
        # removing them here once is enough to keep them gone for good.
        env['documents.document'].search([('type', '=', 'folder')]).unlink()
    except Exception:
        _logger.exception('failed to remove default Documents folders during post_init_hook')

    try:
        # Seed the sidebar filters for whichever members/administrators already
        # exist at install time; res.users.create()/write() keep it in sync afterwards.
        env['ts.availability.filter']._sync_all_member_filters()
    except Exception:
        _logger.exception('failed to sync availability filters during post_init_hook')

    try:
        env['ts.availability.overlap.filter']._sync_all_member_filters()
    except Exception:
        _logger.exception('failed to sync availability overlap filters during post_init_hook')
