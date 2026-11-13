/** An error shown in a card, optionally with a button running `action` (a webview message type). */
class CardError extends Error {
    constructor(message, action = null, actionLabel = null) {
        super(message);
        this.action = action;
        this.actionLabel = actionLabel;
    }
}

module.exports = { CardError };
