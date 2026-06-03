import { registry } from "@web/core/registry";
import { onMounted, onPatched, signal } from "@odoo/owl";
import { CharField, charField } from "@web/views/fields/char/char_field";

// The tooltip is set on the whole <tr>, not just this cell's own span, so that
// hovering anywhere on the matchup's row (e.g. over the score column) shows it.
export class MatchupTooltipField extends CharField {
    static template = "eva.MatchupTooltipField";
    root = signal.ref();

    setup() {
        super.setup();
        const applyRowTooltip = () => {
            const row = this.root()?.closest("tr");
            if (row) {
                row.dataset.tooltipTemplate = "eva.MatchupTooltip";
                row.dataset.tooltipInfo = this.tooltipInfo;
            }
        };
        onMounted(applyRowTooltip);
        onPatched(applyRowTooltip);
    }

    get tooltipInfo() {
        const { data } = this.props.record;
        return JSON.stringify({
            team_a_name: data.team_a_name || "",
            team_b_name: data.team_b_name || "",
            team_a_maps: data.team_a_maps || "-",
            team_b_maps: data.team_b_maps || "-",
        });
    }
}

export const matchupTooltipField = {
    ...charField,
    component: MatchupTooltipField,
};

registry.category("fields").add("matchup_tooltip", matchupTooltipField);
