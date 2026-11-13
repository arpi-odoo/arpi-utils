// "Current Dev" card: where the odoo / enterprise / upgrade checkouts stand, my other
// task branches, and the actions on them. Amend / push go through the arp script
// (same rules as the skill); switch is plain git.

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPOS = ['odoo', 'enterprise', 'upgrade'];
const BASE_RE = /^(master|\d+\.\d+|saas-\d+\.\d+)$/;
const VERSION_RE = /^(saas-\d+\.\d+|\d+\.\d+|master)/;
// "Task: 5136311", "task-5136311", "Task-ID: 5136311"
const TASK_RE = /\btask(?:[- ]?id)?[-:# ]+(\d{5,})/gi;

function expandHome(p) {
    return p.replace(/^~(?=$|\/)/, os.homedir());
}

function rootOf(config) {
    return expandHome(config.get('git.root') || '~');
}

function git(cwd, args) {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, maxBuffer: 20 * 1024 * 1024, timeout: 120000 }, (error, stdout, stderr) => {
            if (error) {
                error.stdout = stdout;
                error.message = (stderr || error.message).trim();
                reject(error);
            } else {
                resolve(stdout.trim());
            }
        });
    });
}

async function tryGit(cwd, args) {
    try {
        return await git(cwd, args);
    } catch {
        return null;
    }
}

/** Run `fn` on every item, at most `limit` at a time. */
async function pool(items, limit, fn) {
    const results = Array.from({ length: items.length });
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i]);
        }
    }));
    return results;
}

const devRemote = (repo) => (repo === 'upgrade' ? 'origin' : 'dev');
const isTaskBranch = (name) => !BASE_RE.test(name) && VERSION_RE.test(name);

function taskIdsIn(text) {
    return [...new Set([...text.matchAll(TASK_RE)].map((m) => Number(m[1])))];
}

/** Base branch of a task branch in this repo (arp's rule: upgrade only has master). */
async function baseOf(cwd, branch) {
    const version = branch.match(VERSION_RE)?.[1];
    if (!version) return null;
    if (BASE_RE.test(branch) || await tryGit(cwd, ['rev-parse', '-q', '--verify', `refs/remotes/origin/${version}`])) {
        return version;
    }
    return 'master';
}

// ------------------------------------------------------------- current branch

/** What a rebase onto origin/<base> would do, without touching the checkout. */
async function forecast(cwd, base, files) {
    const result = { conflicts: [], incoming: [] };
    try {
        await git(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', `origin/${base}`, 'HEAD']);
    } catch (e) {
        // Exit 1 = conflicts: the tree oid, then the conflicted files.
        if (e.code !== 1) return null;
        result.conflicts = e.stdout.trim().split('\n').slice(1).filter(Boolean);
    }
    if (files.length) {
        const log = await tryGit(cwd, ['log', '--format=%h %s', `HEAD..origin/${base}`, '--', ...files]);
        result.incoming = log ? log.split('\n') : [];
    }
    return result;
}

async function repoStatus(root, repo, fetch) {
    const cwd = path.join(root, repo);
    if (!fs.existsSync(path.join(cwd, '.git'))) {
        return { repo, missing: true };
    }
    const gitDir = await git(cwd, ['rev-parse', '--absolute-git-dir']);
    const rebasing = ['rebase-merge', 'rebase-apply'].some((d) => fs.existsSync(path.join(gitDir, d)));
    const branch = await tryGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
    const status = await git(cwd, ['status', '--porcelain']);
    const lines = status ? status.split('\n') : [];
    const result = {
        repo,
        branch,
        rebasing,
        sha: await git(cwd, ['rev-parse', 'HEAD']),
        head: await git(cwd, ['log', '-1', '--format=%h %s']),
        dirty: lines.filter((l) => !l.startsWith('??')).length,
        untracked: lines.filter((l) => l.startsWith('??')).length,
        taskIds: [],
    };
    if (!branch) {
        return { ...result, kind: 'detached' };
    }
    const base = await baseOf(cwd, branch);
    if (!base) {
        return { ...result, kind: 'unknown' };
    }
    const kind = BASE_RE.test(branch) ? 'base' : 'task';
    let fetchError = null;
    if (fetch) {
        try {
            await git(cwd, ['fetch', '-q', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`]);
        } catch (e) {
            fetchError = e.message;
        }
    }
    const counts = await tryGit(cwd, ['rev-list', '--left-right', '--count', `HEAD...origin/${base}`]);
    const [ahead, behind] = counts ? counts.split(/\s+/).map(Number) : [null, null];
    Object.assign(result, { kind, base, ahead, behind, fetchError });
    if (kind !== 'task' || ahead === null) {
        return result;
    }
    // Last known state of the dev branch (arp refreshes it on status/push), no network.
    const remote = `${devRemote(repo)}/${branch}`;
    const remoteSha = await tryGit(cwd, ['rev-parse', '-q', '--verify', `refs/remotes/${remote}`]);
    result.remote = { name: remote, state: !remoteSha ? 'missing' : remoteSha === result.sha ? 'equal' : 'differs' };

    result.messages = await git(cwd, ['log', '--format=%B', `origin/${base}..HEAD`]);
    result.taskIds = taskIdsIn(result.messages);
    const files = (await git(cwd, ['diff', '--name-only', `origin/${base}...HEAD`])).split('\n').filter(Boolean);
    const shortstat = await git(cwd, ['diff', '--shortstat', `origin/${base}...HEAD`]);
    result.diff = {
        files: files.length,
        insertions: Number(shortstat.match(/(\d+) insertion/)?.[1] || 0),
        deletions: Number(shortstat.match(/(\d+) deletion/)?.[1] || 0),
    };
    if (behind > 0) {
        result.forecast = await forecast(cwd, base, files);
    }
    return result;
}

// ------------------------------------------------------------- other branches

// Per repo|branch|sha|base sha: { mine, taskIds, commits }. Only moved branches get re-read.
const branchCache = new Map();

async function repoBranches(root, repo) {
    const cwd = path.join(root, repo);
    if (!fs.existsSync(path.join(cwd, '.git'))) return [];
    const email = (await tryGit(cwd, ['config', 'user.email']) || '').toLowerCase();
    const refs = await git(cwd, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(committerdate:unix)',
        'refs/heads', `refs/remotes/${devRemote(repo)}`, 'refs/remotes/origin']);
    const local = [];
    const remote = new Map();
    const remoteBranches = new Map();
    for (const line of refs.split('\n')) {
        const [ref, sha, date] = line.split('\0');
        if (ref.startsWith('refs/heads/')) {
            local.push({ name: ref.slice(11), sha, date: Number(date) });
        } else {
            remote.set(ref.slice(13), sha);
            if (ref.startsWith(`refs/remotes/${devRemote(repo)}/`)) {
                remoteBranches.set(ref.slice(14 + devRemote(repo).length), sha);
            }
        }
    }
    const bases = new Map();
    const baseFor = (name) => {
        const version = name.match(VERSION_RE)[1];
        return remote.has(`origin/${version}`) ? version : 'master';
    };
    const branches = await pool(local.filter((b) => isTaskBranch(b.name)), 8, async (b) => {
        const base = baseFor(b.name);
        const baseSha = remote.get(`origin/${base}`);
        if (!baseSha) return null;
        bases.set(base, baseSha);
        const key = `${repo}|${b.name}|${b.sha}|${baseSha}`;
        if (!branchCache.has(key)) {
            const log = await tryGit(cwd, ['log', '--format=%ae%x00%B%x1e', `${baseSha}..${b.sha}`]) || '';
            const commits = log.split('\x1e').map((c) => c.trim()).filter(Boolean);
            branchCache.set(key, {
                mine: commits.some((c) => c.split('\0')[0].toLowerCase() === email),
                taskIds: taskIdsIn(log),
                commits: commits.length,
            });
        }
        const info = branchCache.get(key);
        if (!info.mine) return null;
        const remoteSha = remoteBranches.get(b.name);
        return {
            repo,
            name: b.name,
            date: b.date * 1000,
            commits: info.commits,
            taskIds: info.taskIds,
            remote: !remoteSha ? 'missing' : remoteSha === b.sha ? 'equal' : 'differs',
        };
    });
    return branches.filter(Boolean);
}

/** My task branches across the repos, merged by name, most recent first. */
async function listBranches(root) {
    const perRepo = await Promise.all(REPOS.map((repo) => repoBranches(root, repo).catch(() => [])));
    const byName = new Map();
    for (const b of perRepo.flat()) {
        const entry = byName.get(b.name) || { name: b.name, date: 0, taskIds: [], repos: [] };
        entry.date = Math.max(entry.date, b.date);
        entry.taskIds = [...new Set([...entry.taskIds, ...b.taskIds])];
        entry.repos.push({ repo: b.repo, commits: b.commits, remote: b.remote });
        byName.set(b.name, entry);
    }
    return [...byName.values()].sort((a, b) => b.date - a.date);
}

async function fetchGitStatus(config, { fetch = true } = {}) {
    const root = rootOf(config);
    const repos = await Promise.all(REPOS.map((repo) => repoStatus(root, repo, fetch).catch((e) => ({ repo, error: e.message }))));
    const branches = new Set(repos.filter((r) => r.kind === 'task').map((r) => r.branch));
    return {
        repos,
        branch: branches.size === 1 ? [...branches][0] : null,
        taskIds: [...new Set(repos.flatMap((r) => r.taskIds || []))],
        branches: await listBranches(root),
        root,
    };
}

// -------------------------------------------------------------------- actions

/** Files changed by the task commits of a repo, for a diff view. */
async function commitChanges(config, repo) {
    const cwd = path.join(rootOf(config), repo);
    const branch = await git(cwd, ['symbolic-ref', '--short', 'HEAD']);
    const base = await baseOf(cwd, branch);
    const mergeBase = await git(cwd, ['merge-base', `origin/${base}`, 'HEAD']);
    const out = await git(cwd, ['diff', '--name-status', '--no-renames', mergeBase, 'HEAD']);
    return {
        cwd,
        branch,
        base,
        mergeBase,
        files: out ? out.split('\n').map((line) => {
            const [status, file] = line.split('\t');
            return { status, path: path.join(cwd, file) };
        }) : [],
    };
}

/** Tracked files changed in the working tree or the index of a repo, compared with HEAD. */
async function uncommittedChanges(config, repo) {
    const cwd = path.join(rootOf(config), repo);
    const out = await git(cwd, ['diff', '--name-status', '--no-renames', 'HEAD']);
    return out ? out.split('\n').map((line) => {
        const [status, file] = line.split('\t');
        return { status, path: path.join(cwd, file) };
    }) : [];
}

/**
 * Like `cr` without the rebase: in each repo, the task branch where it exists
 * (locally, or on the dev remote as last fetched), else its version branch.
 */
async function switchBranch(config, branch, log) {
    const root = rootOf(config);
    const version = branch.match(VERSION_RE)?.[1] || 'master';
    const plan = [];
    for (const repo of REPOS) {
        const cwd = path.join(root, repo);
        if (!fs.existsSync(path.join(cwd, '.git'))) continue;
        if (await tryGit(cwd, ['status', '--porcelain', '--untracked-files=no'])) {
            throw new Error(`${repo} has uncommitted changes; amend or stash them first.`);
        }
        const gitDir = await git(cwd, ['rev-parse', '--absolute-git-dir']);
        if (['rebase-merge', 'rebase-apply'].some((d) => fs.existsSync(path.join(gitDir, d)))) {
            throw new Error(`${repo} has a rebase in progress.`);
        }
        const has = (ref) => tryGit(cwd, ['rev-parse', '-q', '--verify', ref]);
        let target;
        if (await has(`refs/heads/${branch}`)) {
            target = [branch];
        } else if (await has(`refs/remotes/${devRemote(repo)}/${branch}`)) {
            target = ['-b', branch, '--track', `${devRemote(repo)}/${branch}`];
        } else if (await has(`refs/heads/${version}`)) {
            target = [version];
        } else if (await has(`refs/remotes/origin/${version}`)) {
            target = ['-b', version, '--track', `origin/${version}`];
        } else {
            target = ['master'];
        }
        plan.push({ repo, cwd, target });
    }
    for (const { repo, cwd, target } of plan) {
        log(`[${repo}] git checkout ${target.join(' ')}`);
        await git(cwd, ['checkout', '-q', ...target]);
    }
}

/** Run `arp <args>`, streaming its output to `log`; resolves with { code, result }. */
function runArp(config, args, log) {
    const arp = expandHome(config.get('git.arpPath'));
    return new Promise((resolve) => {
        log(`$ arp ${args.join(' ')}`);
        const child = spawn(arp, args, { env: { ...process.env, ARP_ROOT: rootOf(config) } });
        let result = null;
        let buffer = '';
        const onData = (chunk) => {
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                log(line);
                result = line.match(/^RESULT: (\w+)/)?.[1] ?? result;
            }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('error', (e) => {
            log(`cannot run ${arp}: ${e.message}`);
            resolve({ code: -1, result: 'error' });
        });
        child.on('close', (code) => {
            if (buffer) onData('\n');
            resolve({ code, result: result || (code === 0 ? 'ok' : 'error') });
        });
    });
}

function rebasePrompt(status) {
    const repos = status.repos.filter((r) => r.kind === 'task').map((r) => `${r.repo} (${r.branch} on origin/${r.base})`);
    return [
        'Use the arp skill to rebase my task branches onto their Odoo version branch,',
        `in ${repos.join(', ')}.`,
        '1. Before rebasing, note in each repo `git merge-base HEAD origin/<base>` (the old base).',
        '2. Run `~/.claude/skills/arp/arp rebase` and resolve every conflict as the skill says',
        '   (keep both intents, then `arp continue <repo>`), until RESULT: ok.',
        '3. Then look for bugs the rebase introduces without a textual conflict: in each repo,',
        '   go through the upstream changes between the old base and the new origin/<base> that touch',
        '   files, models, fields, methods, xmlids or views my commit uses or modifies (renames, removals,',
        '   signature or behaviour changes, new required fields, moved code), and check my commit still',
        '   fits them, across repos too (odoo vs enterprise vs upgrade scripts).',
        '   Fix what breaks and run the tests that cover it.',
        '4. Leave those fixes uncommitted (I amend from the dashboard), never push,',
        '   and end with a short summary per repo: conflicts resolved, issues found and fixed.',
    ].join('\n');
}

module.exports = {
    fetchGitStatus, commitChanges, uncommittedChanges, switchBranch, runArp, rebasePrompt, expandHome,
};
