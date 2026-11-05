import { Component, onMounted, onPatched, onWillStart, onWillUnmount, proxy, signal, useProps } from "@odoo/owl";
import { browser } from "@web/core/browser/browser";
import { deserializeDateTime, formatDateTime } from "@web/core/l10n/dates";
import { _t } from "@web/core/l10n/translation";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { standardActionServiceProps } from "@web/webclient/actions/action_plugin";

const SETTINGS_STORAGE_KEY = "eva.call_trainer.settings";
const DEFAULT_SETTINGS = { round_count: 10, lives: 3, time_per_round: 10 };
const COUNTDOWN_SECONDS = 3;
const FEEDBACK_DELAY = { correct: 900, wrong: 2200, timeout: 2200 };
// While waiting for the others to finish, check now and then in case one of
// them left without a word (the server then ends their training).
const RESULTS_POLL_DELAY = 15000;
const TRAINING_MODEL = "eva.call.training";
const PARTICIPANT_MODEL = "eva.call.training.participant";

/**
 * Call Trainer: shows a random image of a map's spot and asks for its call
 * name. Screens: "home" (settings, open lobbies, history), "lobby" (waiting
 * for players), "countdown" / "round" / "feedback" (playing), "results".
 *
 * Every participant plays the same pre-drawn rounds at their own pace; the
 * server owns the timer and the answer checking, the client only displays.
 * Other players' progress comes through the bus channel of the training.
 */
export class CallTrainer extends Component {
    static template = "eva.CallTrainer";

    props = useProps(standardActionServiceProps);
    answerInput = signal.ref();

    setup() {
        this.orm = useService("orm");
        this.action = useService("action");
        this.notification = useService("notification");
        this.busService = useService("bus_service");

        const { params = {}, context = {} } = this.props.action;
        this.mapId = params.map_id || (context.active_model === "eva.map" && context.active_id) || false;
        this.trainingId = params.training_id || this.props.resId || false;
        this.channel = null;
        this.timer = null;
        this.feedbackTimeout = null;
        this.countdownTimer = null;
        this.refreshTimeout = null;
        this.homeRefreshTimeout = null;
        this.pollTimer = null;
        this.focusAnswer = false;

        this.state = proxy({
            screen: "loading",
            home: null,
            maps: [],
            training: null,
            settings: this.loadSettings(),
            round: null,
            answer: "",
            feedback: null,
            timeLeft: 0,
            countdown: 0,
            busy: false,
        });

        this.unsubscribe = this.busService.subscribe("eva.call.training/updated", (payload) => {
            if (payload.training_id === this.trainingId) {
                this.scheduleRefresh();
            }
        });
        this.unsubscribeLobbies = this.busService.subscribe("eva.call.training/lobbies_updated", (payload) => {
            if (this.state.screen === "home" && payload.map_id === this.mapId) {
                this.scheduleHomeRefresh();
            }
        });

        this.onKeydown = (ev) => {
            if (ev.key === "Enter" && this.state.screen === "feedback") {
                ev.preventDefault();
                this.continueAfterFeedback();
            }
        };

        onWillStart(() => this.load());
        onMounted(() => browser.addEventListener("keydown", this.onKeydown));
        onPatched(() => {
            const input = this.answerInput();
            if (this.focusAnswer && input) {
                this.focusAnswer = false;
                input.focus();
            }
        });
        onWillUnmount(() => {
            browser.removeEventListener("keydown", this.onKeydown);
            this.unsubscribe();
            this.unsubscribeLobbies();
            this.leaveChannel();
            this.stopTimers();
            browser.clearTimeout(this.refreshTimeout);
            browser.clearTimeout(this.homeRefreshTimeout);
        });
    }

    // ------------------------------------------------------------------
    // Getters
    // ------------------------------------------------------------------

    get training() {
        return this.state.training;
    }

    get me() {
        return this.training?.me || false;
    }

    get timeRatio() {
        const total = this.training?.time_per_round || 1;
        return Math.max(0, Math.min(1, this.state.timeLeft / total));
    }

    get timerBarClass() {
        if (this.timeRatio < 0.3) {
            return "bg-danger";
        }
        return this.timeRatio < 0.6 ? "bg-warning" : "bg-success";
    }

    get livesDisplay() {
        // One heart per allowed mistake, filled while still available.
        const total = this.training.lives;
        const left = Math.max(0, this.me?.lives_left ?? total);
        return total <= 10 ? { hearts: [...Array(total).keys()].map((i) => i < left) } : { text: `${left} / ${total}` };
    }

    get canPlay() {
        return Boolean(this.state.home?.call_count);
    }

    get myAnswers() {
        return this.me?.answers || [];
    }

    avatarUrl(userId) {
        return `/web/image/res.users/${userId}/avatar_128`;
    }

    formatSeconds(seconds) {
        return seconds ? `${seconds.toFixed(2)}s` : "-";
    }

    formatDate(date) {
        return date ? formatDateTime(deserializeDateTime(date), { showSeconds: false }) : "";
    }

    participantStatus(participant) {
        if (participant.state === "finished") {
            return _t("Finished");
        }
        if (participant.state === "playing") {
            return _t("Round %(current)s / %(total)s", {
                current: Math.min(participant.answered_count + 1, this.training.round_count),
                total: this.training.round_count,
            });
        }
        return _t("Ready");
    }

    // ------------------------------------------------------------------
    // Settings
    // ------------------------------------------------------------------

    loadSettings() {
        try {
            const stored = JSON.parse(browser.localStorage.getItem(SETTINGS_STORAGE_KEY) || "{}");
            return { ...DEFAULT_SETTINGS, ...stored };
        } catch {
            return { ...DEFAULT_SETTINGS };
        }
    }

    saveSettings() {
        try {
            browser.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(this.state.settings));
        } catch {
            // Remembering the settings is a convenience only.
        }
    }

    onSettingInput(name, ev) {
        const value = parseInt(ev.target.value, 10);
        this.state.settings[name] = Number.isNaN(value) ? DEFAULT_SETTINGS[name] : value;
    }

    // ------------------------------------------------------------------
    // Loading & navigation
    // ------------------------------------------------------------------

    async load() {
        if (this.trainingId) {
            await this.openTraining(this.trainingId, { initial: true });
        } else {
            await this.loadHome();
        }
    }

    async loadHome() {
        this.stopTimers();
        this.leaveChannel();
        this.trainingId = false;
        // Switch screens before dropping the training: the lobby/game/results
        // templates would otherwise re-render with a null training while the
        // home data loads.
        this.state.screen = "loading";
        this.state.training = null;
        this.props.updateActionState?.({ resId: false });
        if (this.mapId) {
            this.state.home = await this.orm.call(TRAINING_MODEL, "get_trainer_home", [this.mapId]);
        } else {
            this.state.home = null;
            this.state.maps = await this.orm.searchRead("eva.map", [["call_ids", "!=", false]], ["name", "banner_card"]);
        }
        this.state.screen = "home";
    }

    scheduleHomeRefresh() {
        browser.clearTimeout(this.homeRefreshTimeout);
        this.homeRefreshTimeout = browser.setTimeout(() => this.refreshHome(), 150);
    }

    /** Reload the home data in place (e.g. someone opened a lobby). */
    async refreshHome() {
        const mapId = this.mapId;
        const home = await this.orm.call(TRAINING_MODEL, "get_trainer_home", [mapId]);
        if (this.state.screen === "home" && this.mapId === mapId) {
            this.state.home = home;
        }
    }

    selectMap(mapId) {
        this.mapId = mapId;
        this.loadHome();
    }

    async openTraining(trainingId, { initial = false } = {}) {
        this.stopTimers();
        this.leaveChannel();
        this.trainingId = trainingId;
        this.props.updateActionState?.({ resId: trainingId });
        try {
            await this.refreshTraining();
        } catch (error) {
            if (!initial) {
                throw error;
            }
            // Deleted training (e.g. an empty lobby) in a stale URL.
            await this.loadHome();
            return;
        }
        this.mapId = this.training.map.id;
        this.channel = this.training.channel;
        this.busService.addChannel(this.channel);
    }

    leaveChannel() {
        if (this.channel) {
            this.busService.deleteChannel(this.channel);
            this.channel = null;
        }
    }

    scheduleRefresh() {
        browser.clearTimeout(this.refreshTimeout);
        this.refreshTimeout = browser.setTimeout(() => this.refreshTraining(), 150);
    }

    async refreshTraining() {
        if (!this.trainingId) {
            return;
        }
        const previousState = this.training?.state;
        const training = await this.orm.call(TRAINING_MODEL, "get_trainer_state", [[this.trainingId]]);
        if (training.id !== this.trainingId) {
            return; // Navigated away meanwhile.
        }
        this.state.training = training;
        this.syncScreen(previousState);
    }

    syncScreen(previousState) {
        const training = this.training;
        if (training.state === "lobby") {
            this.state.screen = "lobby";
            return;
        }
        if (training.state === "running" && this.me?.state === "playing") {
            if (["countdown", "round", "feedback"].includes(this.state.screen)) {
                return; // Someone else's progress: only the leaderboard changes.
            }
            if (previousState === "lobby" || this.me.answered_count === 0) {
                this.startCountdown();
            } else {
                this.nextRound();
            }
            return;
        }
        this.stopTimers();
        this.state.screen = "results";
        if (training.state === "running") {
            this.pollTimer = browser.setTimeout(() => this.refreshTraining(), RESULTS_POLL_DELAY);
        }
    }

    // ------------------------------------------------------------------
    // Home & lobby actions
    // ------------------------------------------------------------------

    async createTraining(solo) {
        this.saveSettings();
        const { round_count, lives, time_per_round } = this.state.settings;
        const trainingId = await this.orm.call(TRAINING_MODEL, "create_training", [
            this.mapId, round_count, lives, time_per_round,
        ], { solo });
        await this.openTraining(trainingId);
    }

    async joinTraining(trainingId) {
        await this.orm.call(TRAINING_MODEL, "action_join", [[trainingId]]);
        await this.openTraining(trainingId);
    }

    async startTraining() {
        await this.orm.call(TRAINING_MODEL, "action_start", [[this.trainingId]]);
        await this.refreshTraining();
    }

    async leaveTraining() {
        if (this.me && this.me.state !== "finished") {
            await this.orm.call(TRAINING_MODEL, "action_leave", [[this.trainingId]]);
        }
        await this.loadHome();
    }

    async rematch() {
        const trainingId = await this.orm.call(TRAINING_MODEL, "action_rematch", [[this.trainingId]]);
        await this.openTraining(trainingId);
    }

    async copyInviteLink() {
        try {
            await browser.navigator.clipboard.writeText(browser.location.href);
            this.notification.add(_t("Invite link copied: send it to your teammates."), { type: "success" });
        } catch {
            this.notification.add(_t("Could not copy the link, copy the page URL instead."), { type: "warning" });
        }
    }

    openStats() {
        this.action.doAction("eva.action_eva_call_training_answer", {
            additionalContext: { search_default_map_id: this.mapId },
        });
    }

    openMap() {
        this.action.doAction({
            type: "ir.actions.act_window",
            res_model: "eva.map",
            res_id: this.mapId,
            views: [[false, "form"]],
        });
    }

    // ------------------------------------------------------------------
    // Playing
    // ------------------------------------------------------------------

    startCountdown() {
        this.stopTimers();
        this.state.screen = "countdown";
        this.state.countdown = COUNTDOWN_SECONDS;
        this.countdownTimer = browser.setInterval(() => {
            this.state.countdown--;
            if (this.state.countdown <= 0) {
                browser.clearInterval(this.countdownTimer);
                this.countdownTimer = null;
                this.nextRound();
            }
        }, 1000);
    }

    async nextRound() {
        this.stopTimers();
        const round = await this.orm.call(PARTICIPANT_MODEL, "get_current_round", [[this.me.id]]);
        if (!round) {
            this.state.screen = "loading";
            await this.refreshTraining();
            return;
        }
        this.state.round = round;
        this.state.answer = "";
        this.state.feedback = null;
        this.state.busy = false;
        this.state.timeLeft = round.time_left;
        this.state.screen = "round";
        this.focusAnswer = true;
        const deadline = Date.now() + round.time_left * 1000;
        this.timer = browser.setInterval(() => {
            this.state.timeLeft = Math.max(0, (deadline - Date.now()) / 1000);
            if (this.state.timeLeft <= 0) {
                this.submitAnswer();
            }
        }, 100);
    }

    onAnswerInput(ev) {
        this.state.answer = ev.target.value;
    }

    onAnswerKeydown(ev) {
        if (ev.key === "Enter") {
            ev.preventDefault();
            ev.stopPropagation();
            this.submitAnswer();
        }
    }

    async submitAnswer() {
        if (this.state.screen !== "round" || this.state.busy) {
            return;
        }
        this.state.busy = true;
        this.stopTimers();
        const result = await this.orm.call(PARTICIPANT_MODEL, "submit_answer", [
            [this.me.id], this.state.round.round_number, this.state.answer,
        ]);
        if (!result) {
            // That round was already answered (e.g. from another tab).
            await this.nextRound();
            return;
        }
        Object.assign(this.me, {
            score: result.score,
            lives_left: result.lives_left,
            answered_count: this.state.round.round_number,
        });
        this.state.feedback = result;
        this.state.screen = "feedback";
        this.feedbackTimeout = browser.setTimeout(
            () => this.continueAfterFeedback(),
            FEEDBACK_DELAY[result.result]
        );
    }

    async continueAfterFeedback() {
        if (this.state.screen !== "feedback") {
            return;
        }
        const { finished } = this.state.feedback;
        this.stopTimers();
        if (finished) {
            this.state.screen = "loading";
            await this.refreshTraining();
        } else {
            await this.nextRound();
        }
    }

    stopTimers() {
        browser.clearInterval(this.timer);
        browser.clearInterval(this.countdownTimer);
        browser.clearTimeout(this.feedbackTimeout);
        browser.clearTimeout(this.pollTimer);
        this.timer = this.countdownTimer = this.feedbackTimeout = this.pollTimer = null;
    }
}

registry.category("actions").add("eva_call_trainer", CallTrainer);
