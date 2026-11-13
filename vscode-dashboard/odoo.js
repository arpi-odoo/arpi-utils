// Minimal client for Odoo's JSON-2 external API: POST /json/2/<model>/<method>
// with the API key as a Bearer token and the method's arguments as a JSON object.

class OdooError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

class OdooClient {
    constructor({ url, database, apiKey }) {
        this.url = url.replace(/\/+$/, '');
        this.headers = {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        };
        if (database) {
            this.headers['X-Odoo-Database'] = database;
        }
        this._uid = null;
    }

    async call(model, method, params = {}) {
        let response;
        try {
            response = await fetch(`${this.url}/json/2/${model}/${method}`, {
                method: 'POST',
                headers: this.headers,
                body: JSON.stringify(params),
                signal: AbortSignal.timeout(30000),
            });
        } catch (e) {
            throw new OdooError(0, `Cannot reach ${this.url}: ${e.cause?.message || e.message}`);
        }
        const text = await response.text();
        if (!response.ok) {
            let message = text.slice(0, 300);
            try {
                message = JSON.parse(text).message || message;
            } catch {
                // not JSON (proxy error page...), keep the raw text
            }
            throw new OdooError(response.status, message);
        }
        return JSON.parse(text);
    }

    /** The user the API key belongs to. */
    async uid() {
        if (this._uid === null) {
            const context = await this.call('res.users', 'context_get');
            this._uid = context.uid;
        }
        return this._uid;
    }
}

module.exports = { OdooClient, OdooError };
