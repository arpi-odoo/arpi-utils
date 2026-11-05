'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const glob = require('./glob');

const ACTIVE_KEY = 'scopes.active';
const MANAGED_KEY = 'scopes.managed'; // { [folderUri]: { [excludeKey]: previousValue | null } }
const GLOB_CHARS = /[{}[\]*?,]/;

let statusItem;
let queue = Promise.resolve();

// ---------------------------------------------------------------------------
// Scope definitions
// ---------------------------------------------------------------------------

function getDefinitions() {
    const defs = vscode.workspace.getConfiguration('scopes').get('definitions') || {};
    const result = {};
    for (const [name, def] of Object.entries(defs)) {
        if (Array.isArray(def)) {
            result[name] = { include: def, exclude: [] };
        } else if (def && Array.isArray(def.include)) {
            result[name] = { include: def.include, exclude: def.exclude || [] };
        }
    }
    return result;
}

/**
 * Split "folder:pattern" into its parts. Patterns without a known folder prefix
 * apply to every workspace folder.
 */
function parsePattern(raw) {
    const m = /^([^/:*?{}[\]]+):(.*)$/.exec(raw);
    if (m) {
        const folders = vscode.workspace.workspaceFolders || [];
        if (folders.some(f => f.name === m[1])) {
            return { folder: m[1], pattern: m[2] };
        }
    }
    return { folder: null, pattern: raw };
}

function patternsFor(folder, raws) {
    return raws
        .map(parsePattern)
        .filter(p => p.folder === null || p.folder === folder.name)
        .map(p => p.pattern);
}

// ---------------------------------------------------------------------------
// Resolving a scope into files.exclude entries for one workspace folder
// ---------------------------------------------------------------------------

async function isDirectory(fullPath, dirent) {
    if (dirent.isDirectory()) {
        return true;
    }
    if (dirent.isSymbolicLink()) {
        try {
            return (await fs.promises.stat(fullPath)).isDirectory();
        } catch {
            return false;
        }
    }
    return false;
}

/**
 * Walk the folder, descending only into directories that may contain an included path,
 * and collect every entry that is neither included nor on the way to an include.
 * Returns { excludes: {glob: true}, truncated: bool }.
 */
async function resolveFolder(folder, scope) {
    const includeRaw = patternsFor(folder, scope.include);
    const excludeRaw = patternsFor(folder, scope.exclude);
    const excludes = {};
    for (const p of excludeRaw) {
        excludes[p.replace(/^\.\//, '')] = true;
    }
    if (includeRaw.length === 0) {
        // Nothing of this root is in the scope: hide all its top-level entries.
        excludes['*'] = true;
        return { excludes, truncated: false };
    }

    const config = vscode.workspace.getConfiguration('scopes');
    const skip = new Set(config.get('skipFolders') || []);
    let budget = config.get('maxScannedFolders') || 50000;
    const includes = includeRaw.map(glob.compile);
    const excl = excludeRaw.map(glob.compile);
    const hidden = new Map(); // parent rel path -> [names]
    let truncated = false;

    const root = folder.uri.fsPath;
    const stack = [[]];
    while (stack.length) {
        const segs = stack.pop();
        if (budget-- <= 0) {
            truncated = true;
            break;
        }
        let entries;
        try {
            entries = await fs.promises.readdir(path.join(root, ...segs), { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const child = [...segs, entry.name];
            if (excl.some(p => glob.matches(p, child)) || includes.some(p => glob.matches(p, child))) {
                continue; // already hidden by an exclude glob, or visible with all its content
            }
            if (
                !skip.has(entry.name) &&
                includes.some(p => glob.couldContain(p, child)) &&
                (await isDirectory(path.join(root, ...child), entry))
            ) {
                stack.push(child);
                continue;
            }
            const parent = segs.join('/');
            if (!hidden.has(parent)) {
                hidden.set(parent, []);
            }
            hidden.get(parent).push(entry.name);
        }
    }

    // One brace glob per parent folder keeps settings.json readable.
    for (const [parent, names] of hidden) {
        const prefix = parent ? parent + '/' : '';
        const plain = names.filter(n => !GLOB_CHARS.test(n)).sort();
        for (const n of names.filter(n => GLOB_CHARS.test(n))) {
            excludes[prefix + n] = true;
        }
        if (plain.length === 1) {
            excludes[prefix + plain[0]] = true;
        } else if (plain.length > 1) {
            excludes[prefix + '{' + plain.join(',') + '}'] = true;
        }
    }
    return { excludes, truncated };
}

// ---------------------------------------------------------------------------
// Writing files.exclude without losing the user's own entries
// ---------------------------------------------------------------------------

async function writeExcludes(context, folder, newExcludes) {
    const allManaged = context.workspaceState.get(MANAGED_KEY, {});
    const managed = allManaged[folder.uri.toString()] || {};
    const filesConfig = vscode.workspace.getConfiguration('files', folder.uri);
    const inspected = filesConfig.inspect('exclude');
    const multiRoot = (vscode.workspace.workspaceFolders || []).length > 1;
    // In a single-folder window, folder settings are reported as workspace settings.
    const own = inspected.workspaceFolderValue || (multiRoot ? undefined : inspected.workspaceValue);
    const current = { ...own };

    // Undo what the previous scope added, restoring any value the user had.
    for (const [key, previous] of Object.entries(managed)) {
        if (previous === null) {
            delete current[key];
        } else {
            current[key] = previous;
        }
    }

    const nextManaged = {};
    for (const key of Object.keys(newExcludes)) {
        nextManaged[key] = key in current ? current[key] : null;
        current[key] = true;
    }

    const value = Object.keys(current).length ? current : undefined;
    await filesConfig.update('exclude', value, vscode.ConfigurationTarget.WorkspaceFolder);
    allManaged[folder.uri.toString()] = nextManaged;
    await context.workspaceState.update(MANAGED_KEY, allManaged);
}

// ---------------------------------------------------------------------------
// Activating / clearing
// ---------------------------------------------------------------------------

function enqueue(fn) {
    queue = queue.then(fn, fn).catch(err => {
        vscode.window.showErrorMessage(`Scopes: ${err.message || err}`);
    });
    return queue;
}

function applyScope(context, name) {
    return enqueue(async () => {
        const folders = vscode.workspace.workspaceFolders || [];
        if (!folders.length) {
            vscode.window.showWarningMessage('Scopes: open a folder or workspace first.');
            return;
        }
        const scope = name ? getDefinitions()[name] : null;
        if (name && !scope) {
            vscode.window.showWarningMessage(`Scopes: scope "${name}" is not defined anymore.`);
            name = null;
        }

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: name ? `Applying scope ${name}` : 'Clearing scope' },
            async () => {
                const truncatedIn = [];
                for (const folder of folders) {
                    let excludes = {};
                    if (scope) {
                        const result = await resolveFolder(folder, scope);
                        excludes = result.excludes;
                        if (result.truncated) {
                            truncatedIn.push(folder.name);
                        }
                    }
                    await writeExcludes(context, folder, excludes);
                }
                if (truncatedIn.length) {
                    vscode.window.showWarningMessage(
                        `Scopes: scan limit reached in ${truncatedIn.join(', ')}; some folders may stay visible. ` +
                        'Avoid include patterns starting with ** or raise scopes.maxScannedFolders.'
                    );
                }
            }
        );
        await context.workspaceState.update(ACTIVE_KEY, name || undefined);
        updateStatus(context);
    });
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function updateStatus(context) {
    const active = context.workspaceState.get(ACTIVE_KEY);
    const hasDefs = Object.keys(getDefinitions()).length > 0;
    statusItem.text = active ? `$(filter-filled) ${active}` : '$(filter) No scope';
    statusItem.tooltip = active ? `Scope "${active}" is filtering the Explorer. Click to change.` : 'Select a scope';
    if (active || hasDefs) {
        statusItem.show();
    } else {
        statusItem.hide();
    }
}

async function selectScope(context) {
    const defs = getDefinitions();
    const active = context.workspaceState.get(ACTIVE_KEY);
    const items = [
        { label: '$(eye) Show all files', description: active ? '' : 'active', name: null },
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        ...Object.entries(defs).map(([name, def]) => ({
            label: `${name === active ? '$(check)' : '$(filter)'} ${name}`,
            description: def.include.join('  '),
            detail: def.exclude.length ? `exclude: ${def.exclude.join('  ')}` : undefined,
            name,
        })),
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        { label: '$(edit) Edit scope definitions…', edit: true },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Filter the Explorer by scope', matchOnDescription: true });
    if (!pick) {
        return;
    }
    if (pick.edit) {
        return editDefinitions();
    }
    return applyScope(context, pick.name);
}

async function pickScopeName(defs, placeHolder) {
    const NEW = '$(add) New scope…';
    const pick = await vscode.window.showQuickPick([...Object.keys(defs), NEW], { placeHolder });
    if (!pick) {
        return undefined;
    }
    if (pick !== NEW) {
        return pick;
    }
    return vscode.window.showInputBox({
        prompt: 'Scope name',
        validateInput: v => (!v.trim() ? 'Required' : defs[v.trim()] ? 'Already exists' : undefined),
    }).then(v => v && v.trim());
}

async function findInScope(context) {
    const defs = getDefinitions();
    let name = context.workspaceState.get(ACTIVE_KEY);
    if (!name || !defs[name]) {
        name = await vscode.window.showQuickPick(Object.keys(defs), { placeHolder: 'Search in which scope?' });
        if (!name) {
            return;
        }
    }
    const scope = defs[name];
    const folders = vscode.workspace.workspaceFolders || [];
    const multiRoot = folders.length > 1;
    const toSearchGlobs = raws => {
        const out = [];
        for (const { folder, pattern } of raws.map(parsePattern)) {
            const p = pattern.replace(/^\.\//, '');
            if (!multiRoot) {
                out.push(p.startsWith('**') ? p : `./${p}`);
            } else if (folder) {
                out.push(`./${folder}/${p}`);
            } else if (p.startsWith('**')) {
                out.push(p);
            } else {
                out.push(...folders.map(f => `./${f.name}/${p}`));
            }
        }
        return out.join(', ');
    };
    const editor = vscode.window.activeTextEditor;
    const selection = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : undefined;
    await vscode.commands.executeCommand('workbench.action.findInFiles', {
        query: selection,
        filesToInclude: toSearchGlobs(scope.include),
        filesToExclude: toSearchGlobs(scope.exclude),
        triggerSearch: Boolean(selection),
    });
}

async function editDefinitions() {
    const command = vscode.workspace.workspaceFile
        ? 'workbench.action.openWorkspaceSettingsFile'
        : 'workbench.action.openSettingsJson';
    await vscode.commands.executeCommand(command);
}

async function addToScope(context, kind, uri, uris) {
    const targets = (uris && uris.length ? uris : [uri]).filter(Boolean);
    if (!targets.length) {
        return;
    }
    const config = vscode.workspace.getConfiguration('scopes');
    const defs = getDefinitions();
    const name = await pickScopeName(defs, kind === 'include' ? 'Include in which scope?' : 'Exclude from which scope?');
    if (!name) {
        return;
    }
    const multiRoot = (vscode.workspace.workspaceFolders || []).length > 1;
    const entries = [];
    for (const target of targets) {
        const folder = vscode.workspace.getWorkspaceFolder(target);
        if (!folder) {
            continue;
        }
        const rel = path.relative(folder.uri.fsPath, target.fsPath).split(path.sep).join('/') || '*';
        entries.push(multiRoot ? `${folder.name}:${rel}` : rel);
    }

    // Write back to the level where scopes are defined: the workspace if there is one.
    const inspected = config.inspect('definitions');
    const useWorkspace = Boolean(vscode.workspace.workspaceFolders);
    const stored = { ...(useWorkspace ? inspected.workspaceValue : inspected.globalValue) };
    const def = stored[name] ? { ...stored[name] } : { ...(defs[name] || { include: [], exclude: [] }) };
    def.include = [...(def.include || [])];
    def.exclude = [...(def.exclude || [])];
    for (const e of entries) {
        if (!def[kind].includes(e)) {
            def[kind].push(e);
        }
    }
    if (!def.exclude.length) {
        delete def.exclude;
    }
    stored[name] = def;
    await config.update(
        'definitions',
        stored,
        useWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global
    );
    // The configuration listener reapplies the scope if it is the active one.
    vscode.window.setStatusBarMessage(`Scopes: ${kind}d ${entries.length} path(s) in "${name}"`, 3000);
}

// ---------------------------------------------------------------------------

function activate(context) {
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    statusItem.command = 'scopes.select';
    context.subscriptions.push(statusItem);

    const register = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
    register('scopes.select', () => selectScope(context));
    register('scopes.clear', () => applyScope(context, null));
    register('scopes.refresh', () => applyScope(context, context.workspaceState.get(ACTIVE_KEY)));
    register('scopes.findInScope', () => findInScope(context));
    register('scopes.edit', editDefinitions);
    register('scopes.addInclude', (uri, uris) => addToScope(context, 'include', uri, uris));
    register('scopes.addExclude', (uri, uris) => addToScope(context, 'exclude', uri, uris));

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('scopes')) {
                const active = context.workspaceState.get(ACTIVE_KEY);
                if (active) {
                    applyScope(context, active);
                } else {
                    updateStatus(context);
                }
            }
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            const active = context.workspaceState.get(ACTIVE_KEY);
            if (active) {
                applyScope(context, active);
            }
        })
    );

    updateStatus(context);
    // Re-resolve on startup so folders created since last time are hidden too.
    const active = context.workspaceState.get(ACTIVE_KEY);
    if (active) {
        applyScope(context, active);
    }
}

function deactivate() {}

module.exports = { activate, deactivate };
