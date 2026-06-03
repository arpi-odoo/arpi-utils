import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { graphView } from "@web/views/graph/graph_view";
import { GraphRenderer } from "@web/views/graph/graph_renderer";

// Keyed by the 'result' selection field's display labels (Win/Draw/Loss), since
// that's what ends up as each dataset's/slice's label in the chart data.
const RESULT_COLORS = {
    Win: "#28a745",
    Loss: "#dc3545",
    Draw: "#0d6efd",
};

// Win/loss/draw should always read with the same color regardless of which
// chart type or series order is picked, instead of the default palette's
// position-based assignment.
export class EvaGameResultGraphRenderer extends GraphRenderer {
    setup() {
        super.setup();
        this.orm = useService("orm");
    }

    // Clicking a bar/segment normally opens a list of THIS model's own records
    // (eva.game.result, a per-team virtual view). We want the real eva.game
    // records instead, with the games views and grouped by winner - the
    // domain translation (result/period -> the matching games) is done
    // server-side since it needs to resolve through the SQL view anyway.
    async onGraphClickedFinal(domain, isMiddleClick = false) {
        const action = await this.orm.call("eva.game.result", "action_open_games", [domain]);
        this.actionService.doAction(action, { newWindow: isMiddleClick });
    }

    getBarChartData() {
        const data = super.getBarChartData();
        for (const dataset of data.datasets) {
            if (dataset.label in RESULT_COLORS) {
                dataset.backgroundColor = RESULT_COLORS[dataset.label];
            }
        }
        return data;
    }

    getLineChartData() {
        const data = super.getLineChartData();
        for (const dataset of data.datasets) {
            const color = RESULT_COLORS[dataset.label];
            if (color) {
                dataset.borderColor = color;
                dataset.backgroundColor = color;
                dataset.pointBackgroundColor = color;
                dataset.hoverBackgroundColor = color;
            }
        }
        return data;
    }

    getPieChartData() {
        const data = super.getPieChartData();
        for (const dataset of data.datasets) {
            dataset.backgroundColor = data.labels.map(
                (label, index) => RESULT_COLORS[label] || dataset.backgroundColor[index]
            );
            dataset.hoverBackgroundColor = dataset.backgroundColor;
        }
        return data;
    }
}

export const evaGameResultGraphView = {
    ...graphView,
    Renderer: EvaGameResultGraphRenderer,
};

registry.category("views").add("eva_game_result_graph", evaGameResultGraphView);
