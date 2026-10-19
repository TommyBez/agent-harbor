// Decides whether the shipped application changed since the last release.
// Usage: node scripts/release-scope.mjs <commit> [tag...]  → prints JSON {base, changed, files}
// Only files that end up in, or change how we build, the DMG count; docs, tests,
// skills and workflows do not.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { latestTag } from './next-version.mjs';

export const APP_PATHS = ['app/', 'bin/', 'broker/', 'scripts/dmg.mjs', 'scripts/gui.mjs', 'scripts/native.mjs', 'scripts/package.mjs', 'package.json', 'pnpm-lock.yaml', 'LICENSE'];
export const NOT_APP = ['app/README.md', 'app/.gitignore', 'app/src/tests.zig'];

export function affectsApp(file) {
  if (NOT_APP.includes(file)) return false;
  return APP_PATHS.some(entry => entry.endsWith('/') ? file.startsWith(entry) : file === entry);
}

export function releaseScope(commit, tags, diff) {
  const base = latestTag(tags);
  if (!base) return { base: null, changed: true, files: [] };
  const files = diff(base, commit).filter(affectsApp);
  return { base, changed: files.length > 0, files };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [commit, ...tags] = process.argv.slice(2);
  if (!commit) throw new Error('Usage: node scripts/release-scope.mjs <commit> [tag...]');
  const diff = (from, to) => execFileSync('git', ['diff', '--name-only', '--no-renames', from, to], { encoding: 'utf8' }).split('\n').filter(Boolean);
  process.stdout.write(JSON.stringify(releaseScope(commit, tags, diff)) + '\n');
}
