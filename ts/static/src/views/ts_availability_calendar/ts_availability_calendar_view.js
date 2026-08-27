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
    //
    // Deliberately not using this.model.rangeStart/rangeEnd here: on a
    // touch-capable browser the model silently widens that range by one
    // extra week on each side for swipe support (calendar_model.js
    // loadSurroundings), which would generate the previous/next week too.
    // Recomputing the week bounds from the anchor date instead always
    // matches only the week actually being looked at.
    async onGenerateAvailabilities() {
        if (this.model.scale === "week") {
            const firstDayOfWeek = this.model.meta.firstDayOfWeek;
            const currentWeekOffset = (this.model.date.weekday - firstDayOfWeek + 7) % 7;
            const weekStart = this.model.date.minus({ days: currentWeekOffset }).startOf("day");
            const dateFrom = weekStart.toISODate();
            const dateTo = weekStart.plus({ weeks: 1 }).toISODate();
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
