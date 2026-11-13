// "Current Dev" card summary: the purpose and spec of the current task branch, written by
// `claude -p` from the odoo.com task(s) and the commit messages. Cached per branch until
// the tasks or the commits change, so Claude only runs when there is something new.

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_DESCRIPTION = 12000;

function htmlToText(html) {
    return (html || '')
        .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, '\n')
        .replace(/<li[^>]*>/gi, '- ')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

async function readTasks(client, taskIds) {
    if (!client || !taskIds.length) return [];
    const records = await client.call('project.task', 'read', {
        ids: taskIds,
        fields: ['name', 'description', 'write_date'],
    });
    return records.map((t) => ({
        id: t.id,
        name: t.name,
        updated: t.write_date,
        description: htmlToText(t.description).slice(0, MAX_DESCRIPTION),
    }));
}

function cacheKey(tasks, messages) {
    const hash = crypto.createHash('sha256');
    hash.update(JSON.stringify({ tasks: tasks.map((t) => [t.id, t.updated]), messages }));
    return hash.digest('hex');
}

function buildPrompt(tasks, messages) {
    const parts = [
        'Summarize this development work for a dashboard, in English, for the developer doing it.',
        'Answer with JSON only, no code fence: {"purpose": "...", "spec": "..."}.',
        '- purpose: one or two sentences, why the change is made (the problem or need).',
        '- spec: two to four short sentences, what is changed concretely (models, fields, behaviour).',
        'Plain text, no markdown. Use only the material below; do not invent details.',
    ];
    for (const t of tasks) {
        parts.push('', `=== Task #${t.id}: ${t.name} ===`, t.description || '(no description)');
    }
    for (const m of messages) {
        parts.push('', `=== Commit message (${m.repo}) ===`, m.text);
    }
    return parts.join('\n');
}

function resolveClaude(claudePath) {
    // VS Code started from the desktop may not have ~/.local/bin on its PATH.
    const local = path.join(os.homedir(), '.local', 'bin', 'claude');
    return claudePath === 'claude' && fs.existsSync(local) ? local : claudePath;
}

function runClaude(claudePath, prompt, model) {
    const args = [
        '-p', '--output-format', 'json', '--tools', '', '--no-session-persistence',
        '--setting-sources', '', '--strict-mcp-config',
    ];
    if (model) args.push('--model', model);
    return new Promise((resolve, reject) => {
        const child = execFile(resolveClaude(claudePath), args, { cwd: os.tmpdir(), timeout: 180000, maxBuffer: 10 * 1024 * 1024 },
            (error, stdout, stderr) => {
                if (error) {
                    reject(new Error((stderr || error.message).trim().split('\n').pop()));
                    return;
                }
                try {
                    const out = JSON.parse(stdout);
                    if (out.is_error) throw new Error(out.result || 'Claude returned an error');
                    resolve(out.result);
                } catch (e) {
                    reject(e);
                }
            });
        child.stdin.end(prompt);
    });
}

function parseSummary(text) {
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error('unexpected answer from Claude');
    const { purpose, spec } = JSON.parse(json);
    if (!purpose && !spec) throw new Error('empty summary from Claude');
    return { purpose: String(purpose || ''), spec: String(spec || '') };
}

/**
 * Summary of the current dev branch, from the cache when nothing changed.
 * `cache` is a Memento (globalState); `client` may be null when no Odoo API key is set.
 */
async function summarizeBranch({ branch, taskIds, messages, client, cache, claudePath, model, force = false }) {
    const all = cache.get('workDashboard.summaries') || {};
    const hit = all[branch];
    let tasks = [];
    let note = null;
    if (taskIds.length && !client) {
        note = 'No Odoo API key: summarized from the commit messages only.';
    } else {
        try {
            tasks = await readTasks(client, taskIds);
        } catch (e) {
            // Better keep a summary made with the task than redo one without it.
            if (hit && !hit.note && !force) return hit;
            note = `Task not read (${e.message}): summarized from the commit messages only.`;
        }
    }
    if (!tasks.length && !messages.length) {
        return null;
    }
    const key = cacheKey(tasks, messages);
    if (!force && hit?.key === key) {
        return hit;
    }
    const summary = {
        ...parseSummary(await runClaude(claudePath, buildPrompt(tasks, messages), model)),
        note,
        key,
        at: Date.now(),
    };
    // Keep the 20 most recent branches.
    const kept = Object.entries({ ...all, [branch]: summary }).sort((a, b) => b[1].at - a[1].at).slice(0, 20);
    await cache.update('workDashboard.summaries', Object.fromEntries(kept));
    return summary;
}

/** The cached summary of a branch, without running anything. */
function cachedSummary(cache, branch) {
    return (cache.get('workDashboard.summaries') || {})[branch] || null;
}

module.exports = { summarizeBranch, cachedSummary };
