import { registry } from "@web/core/registry";
import { calendarView } from "@web/views/calendar/calendar_view";
import { CalendarRenderer } from "@web/views/calendar/calendar_renderer";
import { CalendarCommonRenderer } from "@web/views/calendar/calendar_common/calendar_common_renderer";
import { CalendarCommonPopover } from "@web/views/calendar/calendar_common/calendar_common_popover";
import { TsAvailabilityCalendarModel } from "@ts/views/ts_availability_calendar/ts_availability_calendar_view";

// This calendar is a read-only computed report (create/edit/delete are all
// disabled on the view): the base popover still always shows a "View" button
// though (CalendarCommonPopover.isEventViewable is hardcoded to true), which
// would try to open a form view for a record that can't be edited anyway.
export class TsAvailabilityOverlapCommonPopover extends CalendarCommonPopover {
    get isEventViewable() {
        return false;
    }
    get cardPopoverProps() {
        // The footer bar itself (border-top included) is unconditionally
        // rendered by web.CardPopoverRenderer regardless of whether it has
        // any buttons in it, so with no button left to show it must be hidden
        // through this dedicated, scoped CSS class instead (see the .scss
        // file next to this one) rather than at the template level, which
        // would mean patching CardPopoverRenderer for every popover in Odoo.
        return {
            ...super.cardPopoverProps,
            rootClass: `${super.cardPopoverProps.rootClass} o_ts_availability_overlap_popover`,
        };
    }
}

export class TsAvailabilityOverlapCommonRenderer extends CalendarCommonRenderer {
    static components = {
        ...CalendarCommonRenderer.components,
        Popover: TsAvailabilityOverlapCommonPopover,
    };
}

export class TsAvailabilityOverlapRenderer extends CalendarRenderer {
    static components = {
        ...CalendarRenderer.components,
        day: TsAvailabilityOverlapCommonRenderer,
        week: TsAvailabilityOverlapCommonRenderer,
        month: TsAvailabilityOverlapCommonRenderer,
    };
}

export const tsAvailabilityOverlapCalendarView = {
    ...calendarView,
    Model: TsAvailabilityCalendarModel,
    Renderer: TsAvailabilityOverlapRenderer,
};

registry.category("views").add("ts_availability_overlap_calendar", tsAvailabilityOverlapCalendarView);
