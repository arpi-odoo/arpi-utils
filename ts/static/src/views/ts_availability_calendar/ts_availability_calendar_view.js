import { registry } from "@web/core/registry";
import { calendarView } from "@web/views/calendar/calendar_view";
import { CalendarModel } from "@web/views/calendar/calendar_model";

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

export const tsAvailabilityCalendarView = {
    ...calendarView,
    Model: TsAvailabilityCalendarModel,
};

registry.category("views").add("ts_availability_calendar", tsAvailabilityCalendarView);
