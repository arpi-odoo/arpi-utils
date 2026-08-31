import { Component } from "@odoo/owl";
import { DropdownItem } from "@web/core/dropdown/dropdown_item";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { STATIC_ACTIONS_GROUP_NUMBER } from "@web/search/action_menus/action_menus";

export class EvaSessionSubscribeCogMenu extends Component {
    static template = "eva.EvaSessionSubscribeCogMenu";
    static components = { DropdownItem };

    setup() {
        this.action = useService("action");
    }

    onSubscribeClick() {
        this.action.doAction("eva.action_eva_session_subscribe_wizard");
    }
}

registry.category("cogMenu").add("eva-session-subscribe-menu", {
    Component: EvaSessionSubscribeCogMenu,
    groupNumber: STATIC_ACTIONS_GROUP_NUMBER,
    isDisplayed: (env) =>
        env.config.viewType === "calendar" && env.searchModel?.resModel === "eva.session",
});
