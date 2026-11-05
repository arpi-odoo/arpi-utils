# Scopes

PyCharm-like scopes for VS Code: named sets of folders that filter the Explorer and Find in Files.

## Define scopes

In the workspace settings (`.code-workspace` → `settings`) or user settings:

```jsonc
"scopes.definitions": {
    "HR": {
        "include": ["odoo:addons/hr*", "enterprise:hr_*", "enterprise:l10n_*_hr_payroll*"],
        "exclude": ["**/i18n"]
    },
    "Payroll BE": {
        "include": ["enterprise:hr_payroll", "enterprise:l10n_be_hr_payroll*"]
    }
}
```

- `folder:pattern` targets one workspace root, like PyCharm's `file[module]:`. A pattern without a prefix applies to every root.
- A matching folder is shown with all its content. Roots that no pattern targets are hidden entirely.
- Globs: `*`, `?`, `**`, `[abc]`, `[!abc]`, `{a,b}`.

You can also right-click files or folders in the Explorer: **Include in Scope…** / **Exclude from Scope…**.

## Use them

- **Status bar** (bottom left) or the filter icon in the Explorer title: pick a scope, or *Show all files*.
- **Scopes: Find in Scope…** opens the search view with *files to include/exclude* filled in.
- **Scopes: Reapply Active Scope** after creating folders (also done on every startup).

## How it works

The active scope is turned into `files.exclude` entries written in each root's `.vscode/settings.json`.
Entries you added yourself are kept; the extension only removes what it added. Since VS Code search
honours `files.exclude`, hidden folders are also left out of search and Quick Open while a scope is active.
