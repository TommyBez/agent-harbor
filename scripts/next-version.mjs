// Prints the next release version. The source version in package.json is the floor:
// the first release uses it, later releases bump the newest vX.Y.Z tag.
// Usage: node scripts/next-version.mjs <patch|minor|major> [tag...]
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const parse = value => { const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim()); return m ? m.slice(1).map(Number) : null; };
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
export function nextVersion(floor, tags, bump) {
  const base = parse(floor);
  if (!base) throw new Error(`Invalid source version ${floor}.`);
  if (!['patch', 'minor', 'major'].includes(bump)) throw new Error(`Invalid bump ${bump}.`);
  const latest = tags.map(parse).filter(Boolean).sort(compare).at(-1);
  if (!latest) return base.join('.');
  const [major, minor, patch] = latest;
  const bumped = bump === 'major' ? [major + 1, 0, 0] : bump === 'minor' ? [major, minor + 1, 0] : [major, minor, patch + 1];
  return (compare(base, bumped) > 0 ? base : bumped).join('.');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const [bump = 'patch', ...tags] = process.argv.slice(2);
  process.stdout.write(nextVersion(version, tags, bump) + '\n');
}
