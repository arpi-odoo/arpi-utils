import { _t } from "@web/core/l10n/translation";
import { registry } from "@web/core/registry";
import { IntegerField, integerField, integerFieldProps } from "@web/views/fields/integer/integer_field";
import { t, useProps } from "@odoo/owl";

function ordinalSuffix(value) {
    const remainder100 = Math.abs(value) % 100;
    if (remainder100 >= 11 && remainder100 <= 13) {
        return "th";
    }
    switch (Math.abs(value) % 10) {
        case 1:
            return "st";
        case 2:
            return "nd";
        case 3:
            return "rd";
        default:
            return "th";
    }
}

export const labeledIntegerFieldProps = {
    ...integerFieldProps,
    unit: t.string().optional(""),
    ordinal: t.boolean().optional(false),
    width: t.string().optional("4em"),
};

export class LabeledIntegerField extends IntegerField {
    static template = "eva.LabeledIntegerField";
    props = useProps(labeledIntegerFieldProps);

    get formattedValue() {
        const value = super.formattedValue;
        if (this.props.ordinal && this.value !== false && (this.props.readonly || !this.state.hasFocus)) {
            return `${value}${ordinalSuffix(this.value)}`;
        }
        return value;
    }
}

export const labeledIntegerField = {
    ...integerField,
    component: LabeledIntegerField,
    displayName: _t("Integer with unit"),
    supportedOptions: [
        ...integerField.supportedOptions,
        {
            label: _t("Unit"),
            name: "unit",
            type: "string",
            help: _t("Text shown after the value, e.g. 'tokens' or 'of each month'."),
        },
        {
            label: _t("Ordinal"),
            name: "ordinal",
            type: "boolean",
            help: _t("Format the value as an ordinal number (1st, 2nd, 3rd, 4th...)."),
        },
        {
            label: _t("Width"),
            name: "width",
            type: "string",
            help: _t("CSS width of the value itself, e.g. '4em' or '3rem'. Defaults to '4em'."),
        },
    ],
    extractProps(fieldInfo, dynamicInfo) {
        const props = integerField.extractProps(fieldInfo, dynamicInfo);
        props.unit = fieldInfo.options.unit || "";
        props.ordinal = Boolean(fieldInfo.options.ordinal);
        if (fieldInfo.options.width) {
            props.width = fieldInfo.options.width;
        }
        return props;
    },
};

registry.category("fields").add("labeled_integer", labeledIntegerField);
