import { registry } from "@web/core/registry";
import { standardWidgetProps } from "@web/views/widgets/standard_widget_props";
import { Component, useProps } from "@odoo/owl";

export class GameRibbon extends Component {
    static template = "eva.GameRibbon";
    props = useProps(standardWidgetProps);

    get text() {
        return `${this.props.record.data.winner_short_name} Won`;
    }

    get bgClass() {
        if (this.props.record.data.winner_is_my_team) {
            return "text-bg-success";
        }
        if (this.props.record.data.loser_is_my_team) {
            return "text-bg-danger";
        }
        return "text-bg-info";
    }
}

registry.category("view_widgets").add("game_ribbon", {
    component: GameRibbon,
});
