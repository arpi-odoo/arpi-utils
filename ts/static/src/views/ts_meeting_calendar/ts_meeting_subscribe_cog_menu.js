import { Component } from "@odoo/owl";
import { DropdownItem } from "@web/core/dropdown/dropdown_item";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { STATIC_ACTIONS_GROUP_NUMBER } from "@web/search/action_menus/action_menus";

export class TsMeetingSubscribeCogMenu extends Component {
    static template = "ts.TsMeetingSubscribeCogMenu";
    static components = { DropdownItem };

    setup() {
        this.action = useService("action");
    }

    onSubscribeClick() {
        this.action.doAction("ts.action_ts_meeting_subscribe_wizard");
    }
}

registry.category("cogMenu").add("ts-meeting-subscribe-menu", {
    Component: TsMeetingSubscribeCogMenu,
    groupNumber: STATIC_ACTIONS_GROUP_NUMBER,
    isDisplayed: (env) =>
        env.config.viewType === "calendar" && env.searchModel?.resModel === "ts.meeting",
});
