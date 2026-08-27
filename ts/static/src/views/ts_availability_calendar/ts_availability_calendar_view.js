import { registry } from "@web/core/registry";
import { _t } from "@web/core/l10n/translation";
import { useService } from "@web/core/utils/hooks";
import { calendarView } from "@web/views/calendar/calendar_view";
import { CalendarModel } from "@web/views/calendar/calendar_model";
import { CalendarController } from "@web/views/calendar/calendar_controller";

// Always show Monday as the first day of the week here, regardless of the
// current user's language: res.lang's week_start is a single global setting
// shared by every calendar/date-picker in the instance, not something we want
// to change instance-wide just for this one view.
export class TsAvailabilityCalendarModel extends CalendarModel {
    setup(params, services) {
        super.setup(params, services);
        this.meta.firstDayOfWeek = 1;
    }
}

export class TsAvailabilityCalendarController extends CalendarController {
    setup() {
        super.setup();
        this.notificationService = useService("notification");
    }

    // In week view, the currently displayed week is unambiguous, so generate
    // for it directly. In any other scale (day/month/year) there is no single
    // sensible week to pick, so ask the user for a date range instead.
    async onGenerateAvailabilities() {
        if (this.model.scale === "week") {
            const dateFrom = this.model.rangeStart.toISODate();
            const dateTo = this.model.rangeEnd.plus({ days: 1 }).toISODate();
            await this.orm.call(
                "res.users", "action_generate_availabilities_from_weekly_disponibilities",
                [dateFrom, dateTo]
            );
            this.notificationService.add(
                _t("Availabilities generated from your weekly disponibilities."),
                { type: "success" }
            );
            await this.model.load();
        } else {
            this.action.doAction("ts.action_ts_weekly_disponibility_generate_wizard", {
                onClose: () => this.model.load(),
            });
        }
    }
}

export const tsAvailabilityCalendarView = {
    ...calendarView,
    Model: TsAvailabilityCalendarModel,
    Controller: TsAvailabilityCalendarController,
    buttonTemplate: "ts.TsAvailabilityCalendarController.buttons",
};

registry.category("views").add("ts_availability_calendar", tsAvailabilityCalendarView);
