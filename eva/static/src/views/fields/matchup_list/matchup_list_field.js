import { registry } from "@web/core/registry";
import { x2ManyField, X2ManyField } from "@web/views/fields/x2many/x2many_field";
import { useViewButtonHandler } from "@web/views/view_button/view_button_hook";

export class MatchupListField extends X2ManyField {
    setup() {
        super.setup();
        this.onClickViewButton = useViewButtonHandler();
    }

    openRecord(record) {
        this.onClickViewButton({
            clickParams: { name: "action_open_games", type: "object" },
            getResParams: () => ({
                resModel: record.resModel,
                resId: record.resId,
                resIds: record.resIds,
                context: record.context,
            }),
        });
    }
}

export const matchupListField = {
    ...x2ManyField,
    component: MatchupListField,
};

registry.category("fields").add("matchup_list", matchupListField);
