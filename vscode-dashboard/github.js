// "Review Requests" card: open PRs waiting for my review, as in github.com/pulls/inbox.
// Authenticates through VS Code's built-in GitHub account provider.

const vscode = require('vscode');
const { CardError } = require('./errors');

// 'repo' is needed to see private repositories (odoo/enterprise...).
const SCOPES = ['repo'];
const API = 'https://api.github.com';

async function getSession(interactive) {
    return vscode.authentication.getSession('github', SCOPES, interactive ? { createIfNone: true } : { silent: true });
}

async function search(token, query) {
    const url = `${API}/search/issues?${new URLSearchParams({ q: query, sort: 'updated', order: 'desc', per_page: '100' })}`;
    let response;
    try {
        response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
            signal: AbortSignal.timeout(30000),
        });
    } catch (e) {
        throw new CardError(`Cannot reach GitHub: ${e.cause?.message || e.message}`);
    }
    if (response.status === 401) {
        throw new CardError('GitHub rejected the session. Sign in again.', 'githubSignIn', 'Sign in to GitHub');
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new CardError(`GitHub returned HTTP ${response.status}: ${body.message || 'unknown error'}`);
    }
    return body;
}

function toPullRequest(item) {
    return {
        id: item.id,
        number: item.number,
        repo: item.repository_url.replace(`${API}/repos/`, ''),
        title: item.title,
        url: item.html_url,
        author: item.user?.login || '',
        draft: Boolean(item.draft),
        updated: item.updated_at,
        labels: item.labels.map((label) => ({ name: label.name, color: label.color })),
    };
}

async function fetchReviewRequests(config) {
    const session = await getSession(false);
    if (!session) {
        throw new CardError('Not signed in to GitHub.', 'githubSignIn', 'Sign in to GitHub');
    }
    const base = `is:open is:pr archived:false ${config.get('reviews.query') || ''}`.trim();
    const withTeams = config.get('reviews.showTeamRequests');
    const [direct, all] = await Promise.all([
        search(session.accessToken, `${base} user-review-requested:@me`),
        withTeams ? search(session.accessToken, `${base} review-requested:@me`) : null,
    ]);
    const directIds = new Set(direct.items.map((item) => item.id));
    const encode = (q) => `https://github.com/pulls?${new URLSearchParams({ q })}`;
    return {
        login: session.account.label,
        direct: {
            total: direct.total_count,
            items: direct.items.map(toPullRequest),
            url: encode(`${base} user-review-requested:@me`),
        },
        team: withTeams ? {
            // review-requested:@me also matches personal requests; keep only the rest.
            total: all.total_count - direct.total_count,
            items: all.items.filter((item) => !directIds.has(item.id)).map(toPullRequest),
            url: encode(`${base} review-requested:@me -user-review-requested:@me`),
        } : null,
    };
}

// ------------------------------------------------------- my PRs (Current Dev card)

async function graphql(token, query, variables = {}) {
    let response;
    try {
        response = await fetch(`${API}/graphql`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, variables }),
            signal: AbortSignal.timeout(30000),
        });
    } catch (e) {
        throw new Error(`Cannot reach GitHub: ${e.cause?.message || e.message}`);
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.errors?.length) {
        throw new Error(`GitHub: ${body.errors?.[0]?.message || body.message || `HTTP ${response.status}`}`);
    }
    return body.data;
}

const MY_PRS_QUERY = `
query($q: String!) {
  search(query: $q, type: ISSUE, first: 100) {
    nodes {
      ... on PullRequest {
        number title url state isDraft headRefName headRefOid reviewDecision updatedAt
        repository { name owner { login } }
        timelineItems(last: 1, itemTypes: [CLOSED_EVENT]) { nodes { ... on ClosedEvent { actor { login } } } }
        commits(last: 1) {
          nodes { commit { statusCheckRollup {
            state
            contexts(first: 30) { nodes {
              __typename
              ... on StatusContext { context state targetUrl description }
              ... on CheckRun { name status conclusion detailsUrl }
            } }
          } } }
        }
      }
    }
  }
}`;

// Odoo's mergebot pushes the commits itself and closes the PR, so GitHub never says "merged".
const MERGEBOT_LOGINS = ['robodoo'];

const CHECK_STATES = { SUCCESS: 'success', NEUTRAL: 'success', SKIPPED: 'success', FAILURE: 'failure', ERROR: 'failure', TIMED_OUT: 'failure', CANCELLED: 'failure', ACTION_REQUIRED: 'failure', STARTUP_FAILURE: 'failure', STALE: 'failure' };

function toCheck(node) {
    if (node.__typename === 'StatusContext') {
        return { name: node.context, state: node.state === 'EXPECTED' ? 'pending' : (CHECK_STATES[node.state] || 'pending'), url: node.targetUrl, description: node.description || '' };
    }
    return { name: node.name, state: node.status === 'COMPLETED' ? (CHECK_STATES[node.conclusion] || 'pending') : 'pending', url: node.detailsUrl, description: (node.conclusion || node.status || '').toLowerCase() };
}

function toMyPullRequest(node) {
    const rollup = node.commits.nodes[0]?.commit.statusCheckRollup;
    const checks = (rollup?.contexts.nodes || []).map(toCheck);
    // The runbot link is the useful one; else the first failing check.
    const main = checks.find((c) => /runbot/i.test(c.name) && c.state !== 'success')
        || checks.find((c) => c.state === 'failure')
        || checks.find((c) => /runbot/i.test(c.name));
    return {
        repo: node.repository.name,
        fullRepo: `${node.repository.owner.login}/${node.repository.name}`,
        branch: node.headRefName,
        number: node.number,
        title: node.title,
        url: node.url,
        // open, closed, merged
        state: node.state === 'CLOSED' && MERGEBOT_LOGINS.includes(node.timelineItems?.nodes[0]?.actor?.login)
            ? 'merged' : node.state.toLowerCase(),
        draft: node.isDraft,
        review: node.reviewDecision ? node.reviewDecision.toLowerCase() : null, // approved, changes_requested, review_required
        headSha: node.headRefOid,
        updated: node.updatedAt,
        ci: rollup ? {
            state: { SUCCESS: 'success', FAILURE: 'failure', ERROR: 'failure' }[rollup.state] || 'pending',
            url: main?.url || `${node.url}/checks`,
            checks,
        } : null,
    };
}

/** My most recently updated PRs in the configured org, newest first. Null when not signed in. */
async function fetchMyPullRequests(config) {
    const session = await getSession(false);
    if (!session) {
        return null;
    }
    const q = `is:pr author:@me ${config.get('git.prQuery') || 'org:odoo'} sort:updated-desc`;
    const data = await graphql(session.accessToken, MY_PRS_QUERY, { q });
    return data.search.nodes.filter((node) => node.number).map(toMyPullRequest);
}

// ------------------------------------------- review threads (Current Dev card)

const THREAD_FIELDS = `
  number url headRefOid
  reviewThreads(first: 100) {
    nodes {
      id isResolved isOutdated subjectType path line originalLine startLine originalStartLine
      comments(first: 30) { nodes { author { login } body url createdAt diffHunk } }
    }
  }`;

/**
 * Review threads of the given PRs ({ fullRepo, number }), resolved ones included (flagged), keyed "owner/repo#number".
 * Null when not signed in.
 */
async function fetchReviewThreads(prs) {
    if (!prs.length) return {};
    const session = await getSession(false);
    if (!session) return null;
    const parts = prs.map((pr, i) => {
        const [owner, name] = pr.fullRepo.split('/');
        return `pr${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
            pullRequest(number: ${Number(pr.number)}) { ${THREAD_FIELDS} } }`;
    });
    const data = await graphql(session.accessToken, `query { ${parts.join('\n')} }`);
    const result = {};
    prs.forEach((pr, i) => {
        const node = data[`pr${i}`]?.pullRequest;
        if (!node) return;
        result[`${pr.fullRepo}#${pr.number}`] = node.reviewThreads.nodes
            .filter((t) => t.comments.nodes.length)
            .map((t) => ({
                id: t.id,
                resolved: t.isResolved,
                path: t.path,
                outdated: t.isOutdated,
                wholeFile: t.subjectType === 'FILE',
                // Outdated threads lose their line on the current head: fall back to the original one.
                line: t.line ?? t.originalLine,
                startLine: t.line ? t.startLine : t.originalStartLine,
                diffHunk: t.comments.nodes[0].diffHunk,
                comments: t.comments.nodes.map((c) => ({
                    author: c.author?.login || 'ghost',
                    body: c.body,
                    url: c.url,
                    created: c.createdAt,
                })),
            }));
    });
    return result;
}

/** Mark a review thread (GraphQL node id) as resolved on GitHub. */
async function resolveReviewThread(threadId) {
    const session = await getSession(false);
    if (!session) throw new Error('Not signed in to GitHub.');
    await graphql(session.accessToken,
        'mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }',
        { id: threadId });
}

function quote(text) {
    return text.trim().split('\n').map((line) => `> ${line}`).join('\n');
}

/** Prompt for Claude Code to address the unresolved threads of a PR in the local checkout. */
function commentsPrompt({ cwd, branch, localSha, pr, threads }) {
    const blocks = threads.map((t, i) => {
        const lines = t.wholeFile ? ' (whole file)'
            : t.startLine && t.startLine !== t.line ? `:${t.startLine}-${t.line}` : `:${t.line ?? '?'}`;
        const head = `### Thread ${i + 1}: ${t.path}${lines}${t.outdated ? ' (outdated: the code changed since)' : ''}`;
        const hunk = t.outdated && t.diffHunk
            ? `Code it was made on:\n\`\`\`diff\n${t.diffHunk.split('\n').slice(-8).join('\n')}\n\`\`\``
            : null;
        const comments = t.comments.map((c) => `${c.author} (${c.url}):\n${quote(c.body)}`);
        return [head, hunk, ...comments].filter(Boolean).join('\n\n');
    });
    const sync = localSha && localSha !== pr.headSha
        ? `Line numbers refer to the PR head ${pr.headSha.slice(0, 10)}; my local HEAD (${localSha.slice(0, 10)}) differs, so locate the code by content.`
        : 'Line numbers refer to the PR head, which is my local HEAD.';
    return [
        `Address the unresolved review comments on my PR ${pr.fullRepo}#${pr.number} (${pr.url}),`,
        `in the local checkout ${cwd} (branch ${branch}). ${sync}`,
        '',
        ...blocks.flatMap((b) => [b, '']),
        'How to proceed:',
        '1. For each thread, read the code it points at and the whole discussion, and work out what the reviewer',
        '   asks. `gh api repos/' + pr.fullRepo + '/pulls/' + pr.number + '/comments` shows newer comments, if any.',
        '2. Do not guess: when a comment is ambiguous, can be read several ways, conflicts with another comment or',
        '   with what the code needs, has consequences beyond the line it is on, or you think the reviewer is wrong,',
        '   ask me (AskUserQuestion) before changing anything for it, with your recommendation. Group the questions',
        '   up front where you can, then make the clear changes.',
        '3. Fix following the house rules (the odoo-guidelines skill; hr-upgrade-scripts for upgrade scripts), and',
        '   carry the fix over to odoo / enterprise / upgrade when a comment implies it.',
        '4. Run the tests covering what you changed.',
        '5. Leave the changes uncommitted (I amend from the dashboard): no commit, no push, no reply on GitHub,',
        '   no thread resolved.',
        '6. End with, per thread: what you changed (or why nothing), and a short reply I can post to the reviewer.',
    ].join('\n');
}

/** Prompt for Claude Code to review someone else's PR; cwd is its local checkout, if any. */
function reviewPrompt({ pr, cwd }) {
    const where = cwd
        ? [
            `My local checkout of ${pr.repo} is ${cwd}; it is on my own branch, so do not check out, reset or`,
            `modify anything there. Fetch the PR head without checking it out (\`git -C ${cwd} fetch`,
            `https://github.com/${pr.repo} pull/${pr.number}/head\`) and read its files with`,
            '`git show FETCH_HEAD:<path>` when the diff does not give enough context.',
        ]
        : ['There is no local checkout of this repository: read the files through `gh api` when the diff is not enough.'];
    return [
        `Review the PR ${pr.repo}#${pr.number} "${pr.title}" by ${pr.author} (${pr.url}), which awaits my review.`,
        ...where,
        '',
        'How to proceed:',
        `1. Read the description, the commits and the existing discussion (\`gh pr view ${pr.number} -R ${pr.repo} --comments\`,`,
        `   \`gh api repos/${pr.repo}/pulls/${pr.number}/comments\`), then the diff (\`gh pr diff ${pr.number} -R ${pr.repo}\`).`,
        '2. Review it with the odoo-review skill (house rules, web guidelines, security), plus the hr-upgrade-scripts',
        '   skill for upgrade scripts. Look for bugs first: wrong behaviour, missed cases, multi-company, access',
        '   rights, performance (queries in loops), missing or weak tests, missing upgrade script for a renamed or',
        '   removed field/model/xmlid. Check the callers and overrides of what it changes, in enterprise too.',
        '3. Do not repeat points already raised in the discussion, and skip nitpicks the linters catch.',
        '4. Do not post anything on GitHub (no comment, no review, no approval) and do not change any file.',
        '5. End with a verdict (approve / changes needed / questions) and the findings, most important first, each',
        '   with its file:line, why it matters, and a short comment I can post on that line.',
    ].join('\n');
}

module.exports = { fetchReviewRequests, fetchMyPullRequests, fetchReviewThreads, resolveReviewThread, commentsPrompt, reviewPrompt, getSession };
