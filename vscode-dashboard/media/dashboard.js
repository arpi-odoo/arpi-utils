// Webview side: renders the per-card state posted by extension.js. Server data
// only ever goes through textContent, never innerHTML.
(function () {
    const vscode = acquireVsCodeApi();
    const ui = { collapsed: {}, reviewTab: 'direct', ...vscode.getState() };
    const saveUi = () => vscode.setState(ui);
    let state = null;

    // ------------------------------------------------------------------ helpers

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    // VS Code's webview host opens clicked http(s) links itself (in the browser).
    function link(text, url, className) {
        const a = el('a', className, text);
        a.href = url;
        return a;
    }

    function ago(ms) {
        const minutes = Math.round((Date.now() - ms) / 60000);
        if (minutes < 1) return 'just now';
        if (minutes < 60) return `${minutes} min`;
        const hours = Math.round(minutes / 60);
        if (hours < 24) return `${hours} h`;
        const days = Math.round(hours / 24);
        if (days < 14) return `${days} d`;
        return `${Math.round(days / 7)} w`;
    }

    function tag(name, cssColor, colorClass = '') {
        const chip = el('span', `tag ${colorClass}`.trim(), name);
        if (cssColor) chip.style.setProperty('--tag-color', cssColor);
        return chip;
    }

    // -------------------------------------------------------------------- tasks

    const TASK_STATES = {
        '01_in_progress': { label: 'In progress', cls: 'progress' },
        '02_changes_requested': { label: 'Changes requested', cls: 'changes' },
        '03_approved': { label: 'Approved', cls: 'approved' },
        '04_waiting_normal': { label: 'Waiting', cls: 'waiting' },
        '1_done': { label: 'Done', cls: 'done' },
        '1_canceled': { label: 'Canceled', cls: 'canceled' },
    };

    /** My local branches whose commits mention the task, current one first, then most recent. */
    function taskBranches(taskId) {
        const data = state.git?.data;
        if (!data) return [];
        return data.branches.filter((b) => b.taskIds.includes(taskId))
            .sort((a, b) => (b.name === data.branch) - (a.name === data.branch) || b.date - a.date);
    }

    function taskRow(task) {
        const row = el('div', 'row task');
        const priority = Number(task.priority) || 0;
        const stars = el('span', 'priority', '★'.repeat(priority));
        stars.title = `Priority ${priority}/3`;

        const main = el('div', 'row-main');
        const name = link(task.name, task.url, 'row-title');
        name.title = `Open task #${task.id} on Odoo`;
        main.append(name);
        if (task.tags.length) {
            const tags = el('div', 'tags');
            tags.append(...task.tags.map((t) => tag(t.name, null, `color-${t.color || 0}`)));
            main.append(tags);
        }
        const status = TASK_STATES[task.state] || { label: task.state, cls: '' };
        const branches = taskBranches(task.id);
        if (branches.length) {
            const chips = el('div', 'tags');
            for (const b of branches.slice(0, 2)) {
                const current = b.name === state.git?.data?.branch;
                const chip = el(current ? 'span' : 'button', `branch-chip${current ? ' current' : ''}`, `⎇ ${b.name}`);
                chip.title = current ? `${b.name} (checked out)` : `Switch to ${b.name}`;
                if (!current) {
                    chip.disabled = Boolean(state.git?.running);
                    chip.addEventListener('click', () => vscode.postMessage({ type: 'branchAction', action: 'switch', branch: b.name }));
                }
                chips.append(chip);
            }
            if (branches.length > 2) {
                const more = el('span', 'muted', `+${branches.length - 2}`);
                more.title = branches.slice(2).map((b) => b.name).join('\n');
                chips.append(more);
            }
            main.append(chips);
        }
        row.append(stars, main, el('span', `pill ${status.cls}`, status.label));
        return row;
    }

    function renderTasks(body, tasks) {
        if (!tasks.length) {
            body.append(el('p', 'empty', 'No open tasks. Nice.'));
            return;
        }
        // Tasks arrive sorted by stage; group consecutive ones.
        const groups = [];
        for (const task of tasks) {
            const key = task.stage ? task.stage.id : 0;
            if (!groups.length || groups[groups.length - 1].key !== key) {
                groups.push({ key, name: task.stage ? task.stage.name : 'No stage', backlog: task.backlog, tasks: [] });
            }
            groups[groups.length - 1].tasks.push(task);
        }
        for (const group of groups) {
            const details = el('details', 'group');
            details.open = !(ui.collapsed[group.key] ?? group.backlog);
            details.addEventListener('toggle', () => {
                ui.collapsed[group.key] = !details.open;
                saveUi();
            });
            const summary = el('summary');
            summary.append(el('span', '', group.name), el('span', 'group-count', String(group.tasks.length)));
            details.append(summary, ...group.tasks.map(taskRow));
            body.append(details);
        }
    }

    // ------------------------------------------------------------------ reviews

    function prRow(pr) {
        const row = el('div', `row pr${pr.draft ? ' draft' : ''}`);
        const [owner, repo] = pr.repo.split('/');
        const ref = el('span', 'pr-ref', `${owner === 'odoo' ? repo : pr.repo}#${pr.number}`);
        ref.title = `${pr.repo}#${pr.number}`;

        const main = el('div', 'row-main');
        const title = link(pr.title, pr.url, 'row-title');
        title.title = `Open ${pr.repo}#${pr.number} on GitHub`;
        const sub = el('div', 'tags');
        sub.append(el('span', 'author', pr.author));
        for (const label of pr.labels) {
            sub.append(tag(label.name, /^[0-9a-f]{6}$/i.test(label.color) ? `#${label.color}` : null));
        }
        main.append(title, sub);

        const updated = el('span', 'updated', ago(new Date(pr.updated)));
        updated.title = `Updated ${new Date(pr.updated).toLocaleString()}`;
        const review = el('button', 'secondary review-button', 'Review');
        review.title = 'Opens a Claude Code tab with a prompt to review this PR (nothing is posted on GitHub)';
        review.addEventListener('click', () => vscode.postMessage({ type: 'reviewPr', id: pr.id }));
        row.append(ref, main, pr.draft ? el('span', 'pill waiting', 'Draft') : el('span'), review, updated);
        return row;
    }

    function renderReviews(body, data) {
        const lists = { direct: data.direct, team: data.team };
        if (!lists.team) ui.reviewTab = 'direct';
        const list = lists[ui.reviewTab];

        if (lists.team) {
            const tabs = el('div', 'tabs');
            for (const [key, label] of [['direct', 'For me'], ['team', 'Teams']]) {
                const button = el('button', `tab${key === ui.reviewTab ? ' active' : ''}`);
                button.append(label, el('span', 'tab-count', String(lists[key].total)));
                button.title = key === 'direct'
                    ? 'Review requested from you personally'
                    : 'Review requested from one of your teams (codeowners...) but not from you';
                button.addEventListener('click', () => {
                    ui.reviewTab = key;
                    saveUi();
                    render();
                });
                tabs.append(button);
            }
            body.append(tabs);
        }

        if (!list.items.length) {
            body.append(el('p', 'empty', 'Nothing waiting for your review.'));
        } else {
            body.append(...list.items.map(prRow));
        }
        const footer = el('div', 'card-footer');
        const more = list.total - list.items.length;
        footer.append(link(more > 0 ? `${more} more on GitHub →` : 'Open on GitHub →', list.url));
        body.append(footer);
    }

    // ---------------------------------------------------------------------- git

    const REMOTE_STATES = {
        equal: { label: 'Pushed', cls: 'approved', title: 'The dev branch is at HEAD' },
        differs: { label: 'Not pushed', cls: 'changes', title: 'HEAD differs from the dev branch (as last fetched)' },
        missing: { label: 'Never pushed', cls: 'waiting', title: 'No dev branch known locally' },
    };
    const ACTION_LABELS = { amend: ['Amend', 'Amending…'], push: ['Push', 'Pushing…'] };
    const REVIEW_MARKS = {
        approved: ['✓', 'approved', 'Approved'],
        changes_requested: ['✗', 'changes', 'Changes requested'],
        review_required: ['…', 'muted', 'Review required'],
    };
    const CI_LABELS = { success: 'CI passed', failure: 'CI failed', pending: 'CI running' };

    /** Most recently updated PR per "repo:branch". */
    function prIndex(data) {
        const index = new Map();
        for (const pr of data.prs || []) {
            const key = `${pr.repo}:${pr.branch}`;
            if (!index.has(key)) index.set(key, pr);
        }
        return index;
    }

    function prChip(pr, localSha) {
        const chip = el('span', `pr-chip ${pr.draft && pr.state === 'open' ? 'draft' : pr.state}`);
        const number = link(`#${pr.number}`, pr.url);
        number.title = `${pr.fullRepo}#${pr.number} (${pr.draft && pr.state === 'open' ? 'draft' : pr.state}): ${pr.title}`;
        chip.append(number);
        if (pr.state === 'open' && pr.review && REVIEW_MARKS[pr.review]) {
            const [mark, cls, title] = REVIEW_MARKS[pr.review];
            const review = el('span', `review ${cls}`, mark);
            review.title = title;
            chip.append(review);
        }
        if (pr.ci && pr.state === 'open') {
            const ci = link('●', pr.ci.url, `ci-dot ${pr.ci.state}`);
            ci.title = [CI_LABELS[pr.ci.state], ...pr.ci.checks.map((c) => `${c.state === 'success' ? '✓' : c.state === 'failure' ? '✗' : '…'} ${c.name}${c.description ? `: ${c.description}` : ''}`)].join('\n');
            chip.append(ci);
            if (localSha && pr.headSha !== localSha) {
                const outdated = el('span', 'muted', 'older commit');
                outdated.title = `The PR head (${pr.headSha.slice(0, 10)}) is not your local HEAD: CI ran on a different commit`;
                chip.append(outdated);
            }
        }
        return chip;
    }

    function taskById() {
        return new Map((state.tasks?.data || []).map((task) => [task.id, task]));
    }

    function taskLinks(taskIds, odooUrl) {
        const tasks = taskById();
        return taskIds.map((id) => {
            const task = tasks.get(id);
            const a = link(task ? task.name : `Task ${id}`, task ? task.url : `${odooUrl}/odoo/project.task/${id}`, 'task-link');
            a.title = `Task #${id}${task?.stage ? ` · ${task.stage.name}` : ''}`;
            return a;
        });
    }

    /** Purpose and spec of the current branch, written by Claude (see summary.js). */
    function summaryBlock(summary) {
        const box = el('div', 'git-summary');
        if (summary.purpose || summary.spec) {
            for (const [label, text] of [['Purpose', summary.purpose], ['Spec', summary.spec]]) {
                if (!text) continue;
                const line = el('p', 'summary-line');
                line.append(el('span', 'summary-label', label), document.createTextNode(text));
                box.append(line);
            }
        }
        if (summary.note && !summary.loading) {
            box.append(el('p', 'summary-line overdue', summary.note));
        }
        const footer = el('div', 'summary-footer muted');
        if (summary.loading) {
            footer.append(el('span', '', summary.purpose ? 'Updating the summary…' : 'Summarizing the task with Claude…'));
        } else {
            if (summary.error) {
                footer.append(el('span', 'overdue', `Summary failed: ${summary.error}`));
            } else if (summary.at) {
                const when = el('span', '', `Summary by Claude · ${ago(summary.at)}`);
                when.title = new Date(summary.at).toLocaleString();
                footer.append(when);
            }
            const again = el('button', 'link-button', summary.error ? 'Retry' : 'Regenerate');
            again.addEventListener('click', () => vscode.postMessage({ type: 'regenerateSummary' }));
            footer.append(again);
        }
        box.append(footer);
        return box;
    }

    function gitButton(action, label, enabled, title, primary = false) {
        // A disabled button never looks like the call to action.
        const button = el('button', primary && enabled ? 'primary' : 'secondary', label);
        button.disabled = !enabled;
        button.title = title;
        button.addEventListener('click', () => vscode.postMessage({ type: 'gitAction', action }));
        return button;
    }

    function forecastTags(r) {
        if (!r.forecast) return [];
        const tags = [];
        if (r.forecast.conflicts.length) {
            const conflict = el('span', 'forecast conflict', `rebase conflicts in ${r.forecast.conflicts.length} file${r.forecast.conflicts.length > 1 ? 's' : ''}`);
            conflict.title = r.forecast.conflicts.join('\n');
            tags.push(conflict);
        } else {
            const clean = el('span', 'forecast clean', 'rebase is clean');
            clean.title = `No textual conflict with origin/${r.base} (git merge-tree); upstream changes can still break the commit`;
            tags.push(clean);
        }
        if (r.forecast.incoming.length) {
            const n = r.forecast.incoming.length;
            const incoming = el('span', 'forecast incoming', `${n} upstream commit${n > 1 ? 's' : ''} touch${n > 1 ? '' : 'es'} your files`);
            incoming.title = r.forecast.incoming.slice(0, 15).join('\n') + (n > 15 ? `\n… ${n - 15} more` : '');
            tags.push(incoming);
        }
        return tags;
    }

    function repoRow(r, data, prs) {
        const row = el('div', 'row repo');
        row.append(el('span', 'repo-name', r.repo));
        const main = el('div', 'row-main');
        if (r.missing || r.error) {
            main.append(el('span', 'muted', r.missing ? 'No checkout' : r.error));
            row.append(main);
            return row;
        }
        const title = el('span', 'row-title', r.head);
        title.title = r.head;
        main.append(title);
        const sub = el('div', 'tags');
        if (r.kind !== 'task' || r.branch !== data.branch) {
            sub.append(el('span', `branch${r.kind === 'task' ? ' mismatch' : ''}`, r.branch || 'detached HEAD'));
        }
        const pr = r.kind === 'task' && prs.get(`${r.repo}:${r.branch}`);
        if (pr) sub.append(prChip(pr, r.sha));
        if (r.diff) {
            const diff = el('button', 'link-button diffstat');
            diff.append(`${r.diff.files} file${r.diff.files === 1 ? '' : 's'} `,
                el('span', 'ins', `+${r.diff.insertions}`), ' ', el('span', 'del', `−${r.diff.deletions}`));
            diff.title = `Open the changes of ${r.branch} against origin/${r.base}`;
            diff.addEventListener('click', () => vscode.postMessage({ type: 'openDiff', repo: r.repo }));
            sub.append(diff);
        }
        if (r.dirty) {
            const dirty = el('button', 'link-button changes-count', `${r.dirty} uncommitted`);
            dirty.title = `Open the uncommitted changes of ${r.repo} (working tree and index vs HEAD)`;
            dirty.addEventListener('click', () => vscode.postMessage({ type: 'openUncommitted', repo: r.repo }));
            sub.append(dirty);
        }
        if (r.untracked) sub.append(el('span', 'muted', `${r.untracked} untracked`));
        sub.append(...forecastTags(r));
        if (r.fetchError) {
            const warn = el('span', 'overdue', 'fetch failed');
            warn.title = r.fetchError;
            sub.append(warn);
        }
        if (sub.childNodes.length) main.append(sub);

        const distance = el('span', 'distance');
        if (r.base && r.ahead !== null) {
            distance.append(el('span', '', `↑${r.ahead}`), el('span', r.behind ? 'behind' : '', ` ↓${r.behind}`));
            distance.title = `${r.ahead} commit(s) ahead of origin/${r.base}, ${r.behind} behind`;
        }
        let pill = el('span');
        if (r.rebasing) {
            pill = el('span', 'pill changes', 'Rebasing');
            pill.title = 'A rebase is in progress (arp conflicts / arp continue)';
        } else if (r.remote) {
            const remote = REMOTE_STATES[r.remote.state];
            pill = el('span', `pill ${remote.cls}`, remote.label);
            pill.title = `${r.remote.name}: ${remote.title}`;
        } else if (r.kind === 'base') {
            pill = el('span', 'pill', r.base);
        }
        row.append(main, distance, pill);
        return row;
    }

    /**
     * Review threads of the repo's PR, foldable: the unresolved ones with the Fix with Claude button,
     * then the resolved ones (folded by default).
     */
    function repoThreads(r, data, prs) {
        const pr = r.kind === 'task' && prs.get(`${r.repo}:${r.branch}`);
        const all = pr && pr.state === 'open' && data.threads?.[`${pr.fullRepo}#${pr.number}`];
        if (!all?.length) return [];
        const id = `${pr.fullRepo}#${pr.number}`;
        const unresolved = all.filter((t) => !t.resolved);
        const resolved = all.filter((t) => t.resolved);
        const sections = [];
        if (unresolved.length) {
            const fix = el('button', 'primary', 'Fix with Claude');
            fix.title = 'Opens a Claude Code tab with a prompt to address these comments (it asks you when in doubt)';
            fix.addEventListener('click', (event) => {
                // Inside <summary>: don't fold.
                event.preventDefault();
                vscode.postMessage({ type: 'fixComments', repo: r.repo });
            });
            sections.push(threadGroup(`threads:${id}`, false, 'threads', `${r.repo}: unresolved comments`,
                unresolved.map((t) => threadRow(r.repo, t)), fix));
        }
        if (resolved.length) {
            sections.push(threadGroup(`resolvedThreads:${id}`, true, 'threads resolved', `${r.repo}: resolved comments`,
                resolved.map((t) => threadRow(r.repo, t))));
        }
        return sections;
    }

    function threadGroup(key, foldedByDefault, cls, title, rows, button) {
        const details = el('details', `group ${cls}`);
        details.open = !(ui.collapsed[key] ?? foldedByDefault);
        details.addEventListener('toggle', () => {
            ui.collapsed[key] = !details.open;
            saveUi();
        });
        const summary = el('summary');
        summary.append(el('span', '', title), el('span', 'group-count', String(rows.length)));
        if (button) summary.append(button);
        details.append(summary, ...rows);
        return details;
    }

    function threadRow(repo, t) {
        const row = el('div', 'row thread');
        const where = el('button', 'link-button thread-path', t.wholeFile ? t.path : `${t.path}:${t.line ?? '?'}`);
        where.title = t.wholeFile ? `Open ${repo}/${t.path} (comment on the whole file)`
            : `Open ${repo}/${t.path} at line ${t.line ?? '?'} (PR line; the local file may differ)`;
        where.addEventListener('click', () => vscode.postMessage({ type: 'openFile', repo, path: t.path, line: t.line }));
        const head = el('div', 'tags');
        head.append(where);
        if (t.outdated) {
            const outdated = el('span', 'pill waiting', 'Outdated');
            outdated.title = 'The code this thread points at changed since the comment';
            head.append(outdated);
        }
        if (!t.resolved) {
            const resolve = el('button', 'secondary resolve-button', 'Mark as Resolved');
            resolve.title = 'Resolve this conversation on GitHub';
            resolve.addEventListener('click', () => {
                resolve.disabled = true;
                resolve.textContent = 'Resolving…';
                vscode.postMessage({ type: 'resolveThread', id: t.id });
            });
            head.append(resolve);
        }
        row.append(head);
        for (const c of t.comments) {
            const comment = el('div', 'thread-comment');
            const meta = el('div', 'tags');
            const when = link(ago(new Date(c.created)), c.url, 'task-link');
            when.title = `${new Date(c.created).toLocaleString()} · open on GitHub`;
            meta.append(el('span', 'author', c.author), when);
            comment.append(meta, el('div', 'thread-body', c.body.trim()));
            row.append(comment);
        }
        return row;
    }

    function renderGit(body, data, card) {
        const tasks = data.repos.filter((r) => r.kind === 'task');
        const prs = prIndex(data);
        const busy = Boolean(card.running);
        const toolbar = el('div', 'git-toolbar');
        const heading = el('div', 'git-heading');
        const branch = el('code', 'git-branch', data.branch || (tasks.length ? 'Task branches differ' : 'No task branch'));
        if (!data.branch && tasks.length) branch.classList.add('overdue');
        const base = tasks[0]?.base;
        if (base) branch.title = `Based on origin/${base}`;
        heading.append(branch);
        if (data.taskIds.length) {
            const links = el('div', 'tags');
            links.append(...taskLinks(data.taskIds, data.odooUrl));
            heading.append(links);
        }

        const dirty = tasks.filter((r) => r.dirty && !r.rebasing);
        const unpushed = tasks.filter((r) => r.remote?.state !== 'equal');
        const notPushed = tasks.filter((r) => ['differs', 'missing'].includes(r.remote?.state));
        const rebasing = tasks.some((r) => r.rebasing);
        // behind is null when the base is unknown: don't claim it is up to date then.
        const upToDate = tasks.length > 0 && tasks.every((r) => r.behind === 0 && !r.rebasing);
        const label = (action) => ACTION_LABELS[action][card.running === action ? 1 : 0];
        const actions = el('div', 'git-actions');
        actions.append(
            gitButton('amend', label('amend'), !busy && dirty.length > 0,
                dirty.length ? `git add -u + commit --amend in ${dirty.map((r) => r.repo).join(', ')}` : 'No tracked changes to amend',
                dirty.length > 0),
            gitButton('rebase', 'Rebase', !busy && tasks.length > 0 && !upToDate,
                upToDate ? `Already up to date with origin/${base}`
                    : `Opens a Claude Code tab with a prompt to rebase onto origin/${base || '<version>'}, resolve conflicts and check what upstream changes break`,
                true),
            gitButton('push', label('push'), !busy && !rebasing && unpushed.length > 0,
                unpushed.length ? `Force-push (overwrites the dev branch) ${unpushed.map((r) => r.repo).join(', ')}` : 'Dev branches look up to date',
                notPushed.length > 0),
        );
        toolbar.append(heading, actions);
        body.append(toolbar);
        if (data.branch && card.summary?.branch === data.branch) {
            body.append(summaryBlock(card.summary));
        }
        body.append( ...data.repos.flatMap((r) => [repoRow(r, data, prs), ...repoThreads(r, data, prs)]));
        if (data.threadsError) {
            body.append(el('p', 'hint overdue', `Review comments: ${data.threadsError}`));
        }
        if (data.prError) {
            body.append(el('p', 'hint overdue', `PRs: ${data.prError}`));
        } else if (data.prs === null) {
            const hint = el('p', 'hint muted', 'Sign in to GitHub to see PRs and CI. ');
            const signIn = el('button', 'link-button', 'Sign in');
            signIn.addEventListener('click', () => vscode.postMessage({ type: 'githubSignIn' }));
            hint.append(signIn);
            body.append(hint);
        }

        if (card.lastAction) {
            const footer = el('div', 'card-footer');
            const { action, result, at } = card.lastAction;
            footer.append(el('span', result === 'ok' || result === 'nothing' ? 'muted' : 'overdue', `${action}: ${result} · ${ago(at)}`));
            const show = el('button', 'link-button', 'Show output');
            show.addEventListener('click', () => vscode.postMessage({ type: 'showGitOutput' }));
            footer.append(show);
            body.append(footer);
        }
    }

    // -------------------------------------------------------------------- cards

    const CARDS = {
        git: { count: () => '', render: renderGit },
        tasks: { count: (data) => data.filter((task) => !task.backlog).length, render: renderTasks },
        reviews: { count: (data) => data.direct.total, render: renderReviews },
    };

    function renderMeta(section, card) {
        const meta = section.querySelector('.meta');
        if (card.loading) {
            meta.textContent = 'Refreshing…';
        } else if (card.fetchedAt) {
            const when = ago(card.fetchedAt);
            meta.textContent = when === 'just now' ? 'Updated just now' : `Updated ${when} ago`;
            meta.title = new Date(card.fetchedAt).toLocaleString();
        } else {
            meta.textContent = '';
        }
    }

    function renderCard(name) {
        const section = document.querySelector(`[data-card="${name}"]`);
        const card = state[name];
        const body = section.querySelector('.card-body');
        body.replaceChildren();
        section.classList.toggle('loading', card.loading);
        section.querySelector('[data-action="refresh"]').disabled = card.loading;
        section.querySelector('.count').textContent = card.data ? String(CARDS[name].count(card.data)) : '';
        renderMeta(section, card);

        if (card.error) {
            const box = el('div', 'error');
            box.append(el('p', '', card.error));
            if (card.action) {
                const button = el('button', 'primary', card.actionLabel || 'Fix');
                button.addEventListener('click', () => vscode.postMessage({ type: card.action }));
                box.append(button);
            }
            body.append(box);
        }
        if (card.data) {
            CARDS[name].render(body, card.data, card);
        } else if (card.loading) {
            body.append(el('p', 'empty', 'Loading…'));
        }
    }

    function render() {
        for (const name of Object.keys(CARDS)) {
            if (state[name]) renderCard(name);
        }
    }

    for (const section of document.querySelectorAll('[data-card]')) {
        section.querySelector('[data-action="refresh"]').addEventListener('click', () => {
            vscode.postMessage({ type: 'refresh', card: section.dataset.card });
        });
    }
    window.addEventListener('message', (event) => {
        if (event.data.type === 'state') {
            state = event.data.state;
            render();
        }
    });
    setInterval(() => {
        if (!state) return;
        for (const name of Object.keys(CARDS)) {
            renderMeta(document.querySelector(`[data-card="${name}"]`), state[name]);
        }
    }, 30000);
    vscode.postMessage({ type: 'ready' });
})();
