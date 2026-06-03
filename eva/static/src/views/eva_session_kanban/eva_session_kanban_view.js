import { registry } from "@web/core/registry";
import { onMounted } from "@odoo/owl";
import { kanbanView } from "@web/views/kanban/kanban_view";
import { KanbanController } from "@web/views/kanban/kanban_controller";

// Selection-based group by (unlike many2one stages) has no server-side "fold"
// field, so the "cancelled" column can't be folded by default declaratively.
// Fold it once after the initial load instead.
export class EvaSessionKanbanController extends KanbanController {
    setup() {
        super.setup();
        onMounted(() => {
            const cancelledGroup = this.model.root.groups?.find(
                (group) => group.value === "cancelled"
            );
            if (cancelledGroup && !cancelledGroup.isFolded) {
                cancelledGroup.toggle();
            }
        });
    }
}

export const evaSessionKanbanView = {
    ...kanbanView,
    Controller: EvaSessionKanbanController,
};

registry.category("views").add("eva_session_kanban", evaSessionKanbanView);
