import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fail } from './common.mjs';

// Trust dialogs as rendered by Claude Code 2.1.302 and Codex 0.162.1. Harbor answers only these:
// 'folder' trusts the folder the dialog names; 'hooks' trusts Codex hooks for this launch, which
// include Harbor's own observer hooks whenever their command path changes.
const DIALOGS = {
  claude: [
    { kind: 'folder', marker: /Accessing workspace:/, start: /Accessing workspace:/g, folder: /Accessing workspace:[ \t]*(?:\n[ \t]*)+(\/[^\n]*?)[ \t]*$/m, accept: /Yes, I trust this folder/, cursor: '❯', navigate: true },
  ],
  codex: [
    { kind: 'folder', marker: /Trust this folder\?/, start: /Folder access/g, folder: /Folder access[ \t]*(?:\n[ \t]*)+(\/[^\n]*?)[ \t]*$/m, accept: /Trust and continue/, cursor: '›' },
    { kind: 'hooks', marker: /Hooks need review/, start: /Hooks need review/g, accept: /Trust all and continue/, cursor: '›', navigate: true },
  ],
};
// Claude refuses --worktree before trust and exits instead of showing its dialog.
export const WORKTREE_TRUST_ERROR = /Workspace trust not yet accepted/;
// Codex's startup update notice. Harbor only ever skips it, never installs.
export const UPDATE_NOTICE = /Update available[\s\S]*Skip until next version[\s\S]*esc skip/;

/** The trust dialog on a terminal screen: its kind, the folder it names and whether the trusting choice is highlighted. */
export function trustPrompt(provider, screen) {
  for (const dialog of DIALOGS[provider] || []) {
    if (!dialog.marker.test(screen)) continue;
    // Parse only the newest rendering of the dialog.
    const view = screen.slice([...screen.matchAll(dialog.start)].at(-1)?.index ?? 0);
    if (!dialog.accept.test(view)) continue;
    const highlighted = view.split('\n').find(line => line.trimStart().startsWith(dialog.cursor)) || '';
    return { kind: dialog.kind, folder: dialog.folder?.exec(view)?.[1] || null, selected: dialog.accept.test(highlighted) ? 'accept' : 'other', navigate: !!dialog.navigate };
  }
  return null;
}

const configFile = config => path.join(config.home, 'config.json');
function readConfig(config) {
  try { return JSON.parse(fs.readFileSync(configFile(config), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; fail('CONFIG_INVALID', `Cannot read ${configFile(config)}: ${error.message}`); }
}
const real = folder => { try { return fs.realpathSync(folder); } catch { return null; } };
const inside = (root, folder) => { const relative = path.relative(root, folder); return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative)); };

/** Folders the human pre-authorized: Harbor accepts the trust dialog for projects inside them. */
export function trustedFolders(config) {
  const folders = readConfig(config).trustedFolders;
  return Array.isArray(folders) ? folders.filter(folder => typeof folder === 'string' && path.isAbsolute(folder)) : [];
}
export function trustedRoot(config, folder) {
  const target = folder && real(folder);
  if (!target) return null;
  return trustedFolders(config).find(root => { const resolved = real(root); return resolved && inside(resolved, target); }) || null;
}
/** A suggested folder to trust for a whole family of projects: the parent, unless that is too broad. */
export function parentSuggestion(folder) {
  const parent = folder && path.dirname(folder);
  return parent && !tooBroad(parent) ? parent : null;
}
function tooBroad(folder) { return folder === path.parse(folder).root || folder === real(os.homedir()) || folder === os.homedir(); }
export function updateTrustedFolders(config, { add, remove } = {}) {
  let folders = trustedFolders(config);
  if (add !== undefined) {
    if (typeof add !== 'string' || !path.isAbsolute(add)) fail('INVALID_TRUSTED_FOLDER', 'Provide an absolute folder path.');
    const resolved = real(add);
    if (!resolved || !fs.statSync(resolved).isDirectory()) fail('INVALID_TRUSTED_FOLDER', 'The folder does not exist.');
    if (tooBroad(resolved)) fail('TRUSTED_FOLDER_TOO_BROAD', 'Trusting the whole disk or home folder would remove the trust check everywhere. Choose a projects folder.');
    if (!folders.some(folder => real(folder) === resolved)) folders.push(resolved);
  }
  if (remove !== undefined) {
    if (typeof remove !== 'string' || !path.isAbsolute(remove)) fail('INVALID_TRUSTED_FOLDER', 'Provide an absolute folder path.');
    const resolved = real(remove) || remove;
    folders = folders.filter(folder => folder !== remove && (real(folder) || folder) !== resolved);
  }
  const next = { ...readConfig(config), trustedFolders: folders };
  const temporary = configFile(config) + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, configFile(config));
  return folders;
}
/** The trusted folder that authorizes answering this dialog: it must name the launch directory or one of its parents. */
export function autoTrustRoot(config, promptFolder, directory) {
  const folder = promptFolder && real(promptFolder), target = real(directory);
  return folder && target && inside(folder, target) ? trustedRoot(config, folder) : null;
}
export { inside as folderInside };
