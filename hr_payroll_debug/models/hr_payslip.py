
import ipdb

from odoo import models
from odoo.tools.safe_eval.runtime import safe_whitelist

# Rules that forward the whole `localdict` to a helper (e.g. `payslip._get_be_ip(localdict)`)
# drag `print`/`ipdb` along into safe_eval's recursive safety check, which logs a warning
# for every such call. Whitelist them explicitly so they're recognized as trusted instead.
safe_whitelist.add_function('builtins.print')
safe_whitelist.add_function('ipdb.__main__.set_trace')

class HrPayslip(models.Model):
    _inherit = 'hr.payslip'

    def _get_base_local_dict(self):
        local_dict = super()._get_base_local_dict()
        local_dict.update({
            'print': print,
            'ipdb': ipdb.set_trace,
        })
        return local_dict
