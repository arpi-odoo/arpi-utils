# Work Dashboard

A VS Code panel summarizing work items:

- **Current Dev**: where `~/odoo`, `~/enterprise` and `~/upgrade` stand (task branch, commits
  ahead/behind `origin/<version>`, uncommitted changes, pushed or not), with three buttons:
  - **Amend**: `arp amend` (`git add -u` + `commit --amend --no-edit` where there are tracked changes).
  - **Rebase with Claude**: opens a Claude Code chat tab holding a prompt (press Enter to send) to
    rebase through the arp skill, resolve conflicts, then check which upstream changes break the commits; fixes are left
    uncommitted for review, then Amend.
  - **Push**: `arp push` (force-with-lease to the dev remote).
  Their output goes to the *Work Dashboard: Git* output channel.

  Under the branch, a short **Purpose** / **Spec** summary written by Claude (`claude -p`, no
  tools, `workDashboard.summary.model`) from the odoo.com task description and the commit
  messages. It is cached per branch and only regenerated when the task or the commits change
  (or with *Regenerate*); without a usable Odoo API key it falls back to the commit messages.

  Per repo it also shows the PR of the branch (review state, CI dot linking to runbot or the
  failing check, *older commit* when CI did not run on the local HEAD), the size of the change
  (click to open the diff against the merge base), the uncommitted changes (click to open them against HEAD), and, when behind, a rebase forecast:
  `git merge-tree` conflicts and the upstream commits touching the files of the commit.
  Under each repo, its PR's unresolved review threads are listed (foldable; click a path to open
  the file at that line). **Fix with Claude** opens a Claude Code tab holding a prompt to address
  them in the local checkout: it asks for clarification (AskUserQuestion) when a comment is
  ambiguous or looks wrong, leaves the fixes uncommitted, never replies on GitHub nor resolves
  threads, and ends with a suggested reply per thread.
- **Task ↔ branch**: commits mentioning `Task: <id>` / `task-<id>` link a branch to its task:
  the Current Dev card shows its task, and each task row shows its local branches (commits authored
  with my git email). Clicking one checks it out where it exists and the version branch elsewhere
  (like `cr` without the rebase, refused with uncommitted changes).
- **My Tasks**: open odoo.com tasks assigned to me.
- **Review Requests**: open GitHub PRs waiting for my review (like github.com/pulls/inbox).
  **Review with Claude** opens a Claude Code tab holding a prompt to review the PR with the
  odoo-review skill: it reads the diff and discussion through `gh`, fetches the PR head into the local
  odoo / enterprise / upgrade checkout without checking it out, posts nothing on GitHub, and ends with a
  verdict and the findings, each with a comment ready to post.

## Setup

1. Generate an API key on odoo.com: My Profile → Account Security → New API Key.
2. Run **Work Dashboard: Set Odoo API Key…** and paste it. The key is kept in VS Code's
   secret storage (OS keyring). If none is set, `ODOO_API_TOKEN` from the environment is used.
3. Click **Sign in to GitHub** in the review card (or run **Work Dashboard: Sign in to GitHub**).
   This uses VS Code's built-in GitHub account, with the `repo` scope so private repos show up.

## Use

- Click the `☑ N  ⎇ M` item in the status bar (open tasks, PRs requesting your review), or run **Work Dashboard: Open Dashboard**.
- Tasks are grouped by stage, most advanced stage first. Click a task to open it on odoo.com.
- Refreshes every `workDashboard.refreshMinutes` (default 10), on opening the panel, and with ↻.

## Settings

| Setting | Default | |
|---|---|---|
| `workDashboard.odoo.url` | `https://www.odoo.com` | Odoo instance |
| `workDashboard.odoo.database` | `""` | sent as `X-Odoo-Database` if set |
| `workDashboard.tasks.projectIds` | `[1251]` | empty = all projects |
| `workDashboard.tasks.includeClosed` | `false` | include done/canceled |
| `workDashboard.tasks.backlogStages` | `["RD Backlog"]` | not counted in totals, group folded by default |
| `workDashboard.tasks.domain` | `[]` | extra `project.task` domain, e.g. `[["stage_id.name", "!=", "RD Backlog"]]` |
| `workDashboard.reviews.query` | `""` | extra GitHub search qualifiers, e.g. `org:odoo` |
| `workDashboard.reviews.showTeamRequests` | `true` | add a *Teams* tab for PRs requested from my teams |
| `workDashboard.git.root` | `~` | holds the odoo / enterprise / upgrade checkouts |
| `workDashboard.git.arpPath` | `~/.claude/skills/arp/arp` | used by Amend and Push |
| `workDashboard.git.prQuery` | `org:odoo` | where to look for my PRs (100 most recent) |
| `workDashboard.summary.claudePath` | `claude` | CLI used for the Current Dev summary |
| `workDashboard.summary.model` | `haiku` | model of that summary, empty = CLI default |
| `workDashboard.refreshMinutes` | `10` | 0 = no auto refresh |

## How it works

Calls Odoo's JSON-2 API (`POST /json/2/<model>/<method>`, `Authorization: Bearer <key>`):
`res.users/context_get` gives the key's uid, then `project.task/web_search_read` fetches the tasks
where `user_ids` contains it.

GitHub: two `search/issues` queries, `user-review-requested:@me` (the *For me* tab) and
`review-requested:@me` minus those (the *Teams* tab: codeowners and team requests). Each shows the
100 most recently updated; the footer links to the full list on GitHub.

New cards: a fetch module like `tasks.js` / `github.js` registered in `CARDS` in `extension.js`, and a
render function registered in `CARDS` in `media/dashboard.js`.

## Build / install

```bash
npx @vscode/vsce package --allow-missing-repository
code --install-extension work-dashboard-0.5.0.vsix
```
