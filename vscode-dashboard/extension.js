const vscode = require('vscode');
const crypto = require('crypto');
const path = require('path');
const { OdooClient, OdooError } = require('./odoo');
const { CardError } = require('./errors');
const { fetchTasks, countTasks } = require('./tasks');
const {
    fetchReviewRequests, fetchMyPullRequests, fetchReviewThreads, resolveReviewThread, commentsPrompt, reviewPrompt, getSession,
} = require('./github');
const {
    fetchGitStatus, commitChanges, uncommittedChanges, switchBranch, runArp, rebasePrompt, expandHome,
} = require('./git');
const { summarizeBranch, cachedSummary } = require('./summary');

const SECRET_API_KEY = 'workDashboard.odooApiKey';

let context = null;

function config() {
    return vscode.workspace.getConfiguration('workDashboard');
}

// ---------------------------------------------------------------------------
// Cards: each one fetches its data; errors meant for the user are CardErrors.
// ---------------------------------------------------------------------------

async function getApiKey() {
    // A key set through the command wins; the environment variable is a fallback
    // shared with the odoo-task-search skill.
    return (await context.secrets.get(SECRET_API_KEY)) || process.env.ODOO_API_TOKEN || null;
}

async function fetchGitCard(cfg, options) {
    // A local refresh (window focus, after an action) keeps the PRs already known.
    const previous = state.git.data;
    const [status, prs] = await Promise.all([
        fetchGitStatus(cfg, options),
        options.fetch === false && previous
            ? { prs: previous.prs, prError: previous.prError }
            : fetchMyPullRequests(cfg).then((list) => ({ prs: list, prError: null }), (e) => ({ prs: previous?.prs ?? null, prError: e.message })),
    ]);
    const threads = options.fetch === false && previous
        ? { threads: previous.threads, threadsError: previous.threadsError }
        : await fetchReviewThreads(currentPrs({ ...status, ...prs }).map(({ pr }) => pr))
            .then((t) => ({ threads: t, threadsError: null }), (e) => ({ threads: previous?.threads ?? null, threadsError: e.message }));
    return { ...status, ...prs, ...threads, odooUrl: cfg.get('odoo.url').replace(/\/+$/, '') };
}

/** The open PR of each repo on a task branch (the most recently updated one), as { repo, pr }. */
function currentPrs(data) {
    return (data.repos || []).filter((r) => r.kind === 'task').flatMap((r) => {
        const pr = (data.prs || []).find((p) => p.repo === r.repo && p.branch === r.branch);
        return pr && pr.state === 'open' ? [{ repo: r, pr }] : [];
    });
}

const CARDS = {
    git: fetchGitCard,
    tasks: async (cfg) => {
        const apiKey = await getApiKey();
        if (!apiKey) {
            throw new CardError('No Odoo API key set.', 'setApiKey', 'Set API key…');
        }
        const client = new OdooClient({ url: cfg.get('odoo.url'), database: cfg.get('odoo.database'), apiKey });
        try {
            return await fetchTasks(client, cfg);
        } catch (e) {
            if (e instanceof OdooError && e.status === 401) {
                throw new CardError(`Odoo rejected the API key (${e.message}). It may have expired.`, 'setApiKey', 'Set API key…');
            }
            throw e;
        }
    },
    reviews: fetchReviewRequests,
};

/** Per card: { loading, error, action, actionLabel, data, fetchedAt } */
const state = Object.fromEntries(Object.keys(CARDS).map((name) => [name, { loading: false, data: null, fetchedAt: null }]));
const inFlight = {};

function setCardState(name, patch) {
    state[name] = { ...state[name], ...patch };
    panel?.webview.postMessage({ type: 'state', state });
    updateStatusBar();
}

function refreshCard(name, options = {}) {
    // Collapse concurrent refreshes (timer + button + panel opening) into one request.
    inFlight[name] ??= (async () => {
        setCardState(name, { loading: true });
        try {
            const data = await CARDS[name](config(), options);
            setCardState(name, { loading: false, error: null, action: null, data, fetchedAt: Date.now() });
            if (name === 'git') {
                updateSummary({ recheck: options.fetch !== false });
            }
        } catch (e) {
            setCardState(name, {
                loading: false,
                error: e.message,
                action: e instanceof CardError ? e.action : null,
                actionLabel: e instanceof CardError ? e.actionLabel : null,
            });
        }
    })().finally(() => { delete inFlight[name]; });
    return inFlight[name];
}

function refresh() {
    return Promise.all(Object.keys(CARDS).map(refreshCard));
}

// ---------------------------------------------------------------------------
// Current Dev summary: purpose and spec of the branch, by Claude, cached per branch
// ---------------------------------------------------------------------------

let summaryRun = null;
let summarySignature = null;

/**
 * Show the cached summary of the current branch, and ask Claude for a new one when the
 * commits changed, on a full refresh (the task may have been edited: the cache key
 * tells), or when forced.
 */
async function updateSummary({ recheck = false, force = false } = {}) {
    const data = state.git.data;
    const branch = data?.branch;
    if (!branch) {
        if (state.git.summary) setCardState('git', { summary: null });
        return;
    }
    const messages = data.repos
        .filter((r) => r.kind === 'task' && r.messages)
        .map((r) => ({ repo: r.repo, text: r.messages }));
    const signature = JSON.stringify([branch, data.taskIds, messages]);
    if (state.git.summary?.branch !== branch) {
        const hit = cachedSummary(context.globalState, branch);
        setCardState('git', { summary: hit ? { ...hit, branch } : null });
    }
    if (summaryRun || (!force && !recheck && signature === summarySignature)) {
        return;
    }
    summarySignature = signature;
    summaryRun = (async () => {
        setCardState('git', { summary: { ...state.git.summary, branch, loading: true, error: null } });
        try {
            const apiKey = await getApiKey();
            const cfg = config();
            const client = apiKey
                ? new OdooClient({ url: cfg.get('odoo.url'), database: cfg.get('odoo.database'), apiKey })
                : null;
            const summary = await summarizeBranch({
                branch,
                taskIds: data.taskIds,
                messages,
                client,
                cache: context.globalState,
                claudePath: expandHome(cfg.get('summary.claudePath') || 'claude'),
                model: cfg.get('summary.model'),
                force,
            });
            setCardState('git', { summary: summary && { ...summary, branch } });
        } catch (e) {
            // Retry on the next refresh.
            summarySignature = null;
            setCardState('git', { summary: { ...state.git.summary, branch, loading: false, error: e.message } });
        }
    })().finally(() => { summaryRun = null; });
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

let statusItem = null;

function updateStatusBar() {
    const parts = [];
    const tips = [];
    const { tasks, reviews } = state;
    if (tasks.error) {
        parts.push('$(warning) Tasks');
        tips.push(`Tasks: ${tasks.error}`);
    } else if (tasks.data) {
        const count = countTasks(tasks.data);
        parts.push(`$(checklist) ${count}`);
        tips.push(`${count} open tasks`);
    }
    if (reviews.error) {
        parts.push('$(warning) Reviews');
        tips.push(`Reviews: ${reviews.error}`);
    } else if (reviews.data) {
        parts.push(`$(git-pull-request) ${reviews.data.direct.total}`);
        tips.push(`${reviews.data.direct.total} PRs requesting your review`
            + (reviews.data.team ? ` (+${reviews.data.team.total} via teams)` : ''));
    }
    statusItem.text = parts.join('  ') || '$(sync~spin) Dashboard';
    statusItem.tooltip = `Work Dashboard\n${tips.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function setApiKey() {
    const key = await vscode.window.showInputBox({
        title: 'Odoo API key',
        prompt: `Generate one in ${config().get('odoo.url')}: My Profile → Account Security → New API Key. Stored in VS Code's secret storage.`,
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() ? null : 'The key cannot be empty'),
    });
    if (key) {
        await context.secrets.store(SECRET_API_KEY, key.trim());
        await refreshCard('tasks');
    }
}

async function githubSignIn() {
    try {
        await getSession(true);
    } catch (e) {
        vscode.window.showErrorMessage(`Work Dashboard: GitHub sign-in failed: ${e.message}`);
    }
    // onDidChangeSessions refreshes the card when the sign-in succeeds.
}

// ---------------------------------------------------------------------------
// Git actions
// ---------------------------------------------------------------------------

let gitOutput = null;

const ARP_ACTIONS = { amend: 'Amend', push: 'Push' };

async function runGitAction(action) {
    if (action === 'rebase') {
        return rebaseWithClaude();
    }
    if (!(action in ARP_ACTIONS) || state.git.running) {
        return;
    }
    setCardState('git', { running: action });
    gitOutput.show(true);
    // The button is an explicit click: overwrite the dev branch even when it holds
    // commits this clone never saw (e.g. pushed from a branch recreated since).
    const args = action === 'push' ? ['push', '--force'] : [action];
    const { result } = await runArp(config(), args, (line) => gitOutput.appendLine(line));
    gitOutput.appendLine('');
    setCardState('git', { running: null, lastAction: { action, result, at: Date.now() } });
    if (result !== 'ok' && result !== 'nothing') {
        vscode.window.showWarningMessage(`Work Dashboard: arp ${action} ended with ${result}. See the output.`);
    }
    // After a push, the PRs' CI restarts: re-read them too.
    await refreshCard('git', { fetch: action === 'push' });
}

async function openCommitDiff(repo) {
    try {
        const gitApi = vscode.extensions.getExtension('vscode.git')?.exports.getAPI(1);
        if (!gitApi) throw new Error('the built-in Git extension is not available');
        const { branch, base, mergeBase, files } = await commitChanges(config(), repo);
        if (!files.length) {
            vscode.window.showInformationMessage(`Work Dashboard: no change in ${repo} compared with origin/${base}.`);
            return;
        }
        const resources = files.map((f) => {
            const uri = vscode.Uri.file(f.path);
            return [uri, gitApi.toGitUri(uri, mergeBase), gitApi.toGitUri(uri, 'HEAD')];
        });
        await vscode.commands.executeCommand('vscode.changes', `${repo}: ${branch} vs origin/${base}`, resources);
    } catch (e) {
        vscode.window.showErrorMessage(`Work Dashboard: cannot open the changes of ${repo}: ${e.message}`);
    }
}

async function openUncommittedDiff(repo) {
    try {
        const gitApi = vscode.extensions.getExtension('vscode.git')?.exports.getAPI(1);
        if (!gitApi) throw new Error('the built-in Git extension is not available');
        const files = await uncommittedChanges(config(), repo);
        if (!files.length) {
            vscode.window.showInformationMessage(`Work Dashboard: no uncommitted change in ${repo}.`);
            return;
        }
        const resources = files.map((f) => {
            const uri = vscode.Uri.file(f.path);
            return [uri, f.status === 'A' ? undefined : gitApi.toGitUri(uri, 'HEAD'), f.status === 'D' ? undefined : uri];
        });
        await vscode.commands.executeCommand('vscode.changes', `${repo}: uncommitted changes`, resources);
    } catch (e) {
        vscode.window.showErrorMessage(`Work Dashboard: cannot open the uncommitted changes of ${repo}: ${e.message}`);
    }
}

async function runBranchAction(action, branch) {
    if (state.git.running) {
        return;
    }
    const log = (line) => line && gitOutput.appendLine(line);
    try {
        if (action === 'switch') {
            setCardState('git', { running: 'switch' });
            log(`$ switch to ${branch}`);
            await switchBranch(config(), branch, log);
        } else {
            return;
        }
        setCardState('git', { lastAction: { action, result: 'ok', at: Date.now() } });
    } catch (e) {
        log(`ERROR ${e.message}`);
        setCardState('git', { lastAction: { action, result: 'error', at: Date.now() } });
        vscode.window.showErrorMessage(`Work Dashboard: ${e.message}`);
    } finally {
        log('');
        setCardState('git', { running: null });
        await refreshCard('git', { fetch: action === 'switch' });
    }
}

async function openClaude(prompt) {
    // Undocumented command of the Claude Code extension: (sessionId, initialPrompt) opens
    // a new conversation tab with the prompt in its input, left for the user to send.
    try {
        await vscode.commands.executeCommand('claude-vscode.editor.open', undefined, prompt);
    } catch (e) {
        vscode.window.showErrorMessage(`Work Dashboard: could not open Claude Code (${e.message || e}).`);
    }
}

async function rebaseWithClaude() {
    const status = state.git.data;
    if (!status?.repos.some((r) => r.kind === 'task')) {
        vscode.window.showInformationMessage('Work Dashboard: no repository is on a task branch.');
        return;
    }
    await openClaude(rebasePrompt(status));
}

async function fixCommentsWithClaude(repoName) {
    const data = state.git.data;
    const current = data && currentPrs(data).find(({ repo }) => repo.repo === repoName);
    const threads = current && data.threads?.[`${current.pr.fullRepo}#${current.pr.number}`]?.filter((t) => !t.resolved);
    if (!threads?.length) {
        vscode.window.showInformationMessage(`Work Dashboard: no unresolved comment on the ${repoName} PR.`);
        return;
    }
    await openClaude(commentsPrompt({
        cwd: path.join(data.root, repoName),
        branch: current.repo.branch,
        localSha: current.repo.sha,
        pr: current.pr,
        threads,
    }));
}

async function resolveThread(threadId) {
    try {
        await resolveReviewThread(threadId);
    } catch (e) {
        vscode.window.showErrorMessage(`Work Dashboard: could not resolve the comment (${e.message}).`);
        panel?.webview.postMessage({ type: 'state', state });
        return;
    }
    // Flag it locally rather than refetching every thread.
    const data = state.git.data;
    if (data?.threads) {
        const threads = Object.fromEntries(Object.entries(data.threads)
            .map(([key, list]) => [key, list.map((t) => (t.id === threadId ? { ...t, resolved: true } : t))]));
        setCardState('git', { data: { ...data, threads } });
    }
}

const LOCAL_REPOS = { 'odoo/odoo': 'odoo', 'odoo/enterprise': 'enterprise', 'odoo/upgrade': 'upgrade' };

async function reviewWithClaude(prId) {
    const data = state.reviews.data;
    const pr = data && [...data.direct.items, ...(data.team?.items || [])].find((p) => p.id === prId);
    if (!pr) {
        return;
    }
    const local = LOCAL_REPOS[pr.repo];
    const cwd = local && path.join(expandHome(config().get('git.root') || '~'), local);
    await openClaude(reviewPrompt({ pr, cwd }));
}

async function openRepoFile(repo, file, line) {
    try {
        const uri = vscode.Uri.file(path.join(state.git.data.root, repo, file));
        const position = new vscode.Position(Math.max(0, (Number(line) || 1) - 1), 0);
        await vscode.window.showTextDocument(uri, { selection: new vscode.Range(position, position), preview: true });
    } catch (e) {
        vscode.window.showErrorMessage(`Work Dashboard: cannot open ${repo}/${file}: ${e.message}`);
    }
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

let panel = null;

const VIEW_TYPE = 'workDashboard';

function webviewOptions() {
    return {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    };
}

async function openPanel() {
    if (panel) {
        panel.reveal();
        return;
    }
    const newPanel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Work Dashboard', vscode.ViewColumn.Active, {
        ...webviewOptions(),
        retainContextWhenHidden: true,
    });
    setupPanel(newPanel);
    // A fresh panel is the active editor: pin it, which also moves it to the front of the group.
    await vscode.commands.executeCommand('workbench.action.pinEditor');
}

/** Wire a new or restored (after a window reload) panel. */
function setupPanel(newPanel) {
    panel = newPanel;
    panel.webview.options = webviewOptions();
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    panel.iconPath = new vscode.ThemeIcon('dashboard');
    panel.webview.html = renderHtml(panel.webview, media);
    panel.webview.onDidReceiveMessage((message) => {
        switch (message.type) {
            case 'ready':
                panel.webview.postMessage({ type: 'state', state });
                for (const [name, card] of Object.entries(state)) {
                    if (!card.fetchedAt || Date.now() - card.fetchedAt > 60 * 1000) {
                        refreshCard(name);
                    }
                }
                break;
            case 'refresh':
                if (message.card in CARDS) {
                    refreshCard(message.card);
                }
                break;
            case 'setApiKey':
                setApiKey();
                break;
            case 'githubSignIn':
                githubSignIn();
                break;
            case 'gitAction':
                runGitAction(message.action);
                break;
            case 'openDiff':
                openCommitDiff(message.repo);
                break;
            case 'openUncommitted':
                openUncommittedDiff(message.repo);
                break;
            case 'fixComments':
                fixCommentsWithClaude(message.repo);
                break;
            case 'resolveThread':
                resolveThread(message.id);
                break;
            case 'reviewPr':
                reviewWithClaude(message.id);
                break;
            case 'openFile':
                openRepoFile(message.repo, message.path, message.line);
                break;
            case 'branchAction':
                runBranchAction(message.action, message.branch);
                break;
            case 'regenerateSummary':
                updateSummary({ force: true });
                break;
            case 'showGitOutput':
                gitOutput.show(true);
                break;
        }
    });
    panel.onDidChangeViewState(() => {
        if (panel.visible) refreshCard('git', { fetch: false });
    });
    panel.onDidDispose(() => { panel = null; });
}

function cardHtml(name, title, className = '') {
    return `
        <section class="card ${className}" data-card="${name}">
            <header class="card-header">
                <h2>${title} <span class="count"></span></h2>
                <span class="meta"></span>
                <button class="icon-button" data-action="refresh" title="Refresh">↻</button>
            </header>
            <div class="card-body"></div>
        </section>`;
}

function renderHtml(webview, media) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const asset = (name) => webview.asWebviewUri(vscode.Uri.joinPath(media, name));
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${asset('dashboard.css')}">
    <title>Work Dashboard</title>
</head>
<body>
    <main class="grid">
        ${cardHtml('git', 'Current Dev', 'wide')}
        ${cardHtml('tasks', 'My Tasks')}
        ${cardHtml('reviews', 'Review Requests')}
    </main>
    <script nonce="${nonce}" src="${asset('dashboard.js')}"></script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------

let timer = null;

function restartTimer() {
    clearInterval(timer);
    const minutes = config().get('refreshMinutes');
    if (minutes > 0) {
        timer = setInterval(refresh, minutes * 60 * 1000);
    }
}

function activate(ctx) {
    context = ctx;
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    statusItem.command = 'workDashboard.open';
    updateStatusBar();
    statusItem.show();
    gitOutput = vscode.window.createOutputChannel('Work Dashboard: Git');

    ctx.subscriptions.push(
        statusItem,
        gitOutput,
        vscode.commands.registerCommand('workDashboard.gitAmend', () => runGitAction('amend')),
        vscode.commands.registerCommand('workDashboard.gitRebase', () => runGitAction('rebase')),
        vscode.commands.registerCommand('workDashboard.gitPush', () => runGitAction('push')),
        vscode.window.onDidChangeWindowState((windowState) => {
            // Branches move in terminals too: cheap local re-read when coming back.
            if (windowState.focused && panel?.visible) refreshCard('git', { fetch: false });
        }),
        vscode.commands.registerCommand('workDashboard.open', openPanel),
        // Restore the panel (and its pinned tab) across window reloads.
        vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
            async deserializeWebviewPanel(restoredPanel) {
                if (panel) {
                    restoredPanel.dispose();
                    return;
                }
                setupPanel(restoredPanel);
            },
        }),
        vscode.commands.registerCommand('workDashboard.refresh', refresh),
        vscode.commands.registerCommand('workDashboard.setApiKey', setApiKey),
        vscode.commands.registerCommand('workDashboard.githubSignIn', githubSignIn),
        vscode.commands.registerCommand('workDashboard.clearApiKey', async () => {
            await ctx.secrets.delete(SECRET_API_KEY);
            vscode.window.showInformationMessage('Work Dashboard: Odoo API key forgotten.');
            await refreshCard('tasks');
        }),
        vscode.authentication.onDidChangeSessions((event) => {
            if (event.provider.id === 'github') {
                refreshCard('reviews');
                refreshCard('git', { fetch: false });
            }
        }),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('workDashboard')) {
                restartTimer();
                refresh();
            }
        }),
        { dispose: () => clearInterval(timer) },
    );
    restartTimer();
    refresh();
}

function deactivate() {}

module.exports = { activate, deactivate };
