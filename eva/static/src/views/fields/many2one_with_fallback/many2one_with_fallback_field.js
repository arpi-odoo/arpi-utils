import { _t } from "@web/core/l10n/translation";
import { registry } from "@web/core/registry";
import { buildM2OFieldDescription, Many2OneField } from "@web/views/fields/many2one/many2one_field";

export class Many2OneWithFallbackField extends Many2OneField {
    static template = "eva.Many2OneWithFallbackField";
}

export const many2OneWithFallbackField = {
    ...buildM2OFieldDescription(Many2OneWithFallbackField),
    displayName: _t("Many2one (with fallback text)"),
};

registry.category("fields").add("many2one_with_fallback", many2OneWithFallbackField);
