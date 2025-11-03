
import ipdb

from odoo import models

class HrPayslip(models.Model):
    _inherit = 'hr.payslip'

    def _get_base_local_dict(self):
        local_dict = super()._get_base_local_dict()
        local_dict.update({
            'print': print,
            'ipdb': ipdb.set_trace,
        })
        return local_dict
