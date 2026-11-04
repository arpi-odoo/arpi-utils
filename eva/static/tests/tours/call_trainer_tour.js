import { registry } from "@web/core/registry";

registry.category("web_tour.tours").add("eva_call_trainer_solo", {
    steps: () => [
        {
            content: "Open the Call Trainer from the map",
            trigger: "button[name=action_open_call_trainer]",
            run: "click",
        },
        {
            trigger: "#eva_ct_rounds",
            run: "edit 2",
        },
        {
            trigger: "#eva_ct_lives",
            run: "edit 0",
        },
        {
            trigger: "button:contains(Play solo)",
            run: "click",
        },
        {
            content: "The countdown is shown before the first round",
            trigger: ".o_eva_call_trainer_countdown",
        },
        {
            trigger: ".o_eva_call_trainer_image",
        },
        {
            trigger: ".o_eva_call_trainer input:enabled",
            run: "edit definitely not a call && press Enter",
        },
        {
            content: "Wrong answer: the right call is revealed",
            trigger: ".o_eva_call_trainer_feedback:contains(It was)",
        },
        {
            content: "Sudden death: straight to the results",
            trigger: ".o_eva_call_trainer h2:contains(results)",
        },
        {
            trigger: ".o_eva_call_trainer .card:contains(Answered)",
        },
        {
            trigger: ".o_eva_call_trainer button:contains(Back)",
            run: "click",
        },
        {
            content: "The training shows up in the history",
            trigger: ".o_eva_call_trainer h4:contains(My last trainings)",
        },
    ],
});
