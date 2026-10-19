// Writes a release version into package.json and app/app.zon in the working tree only.
// CI stamps the version it is about to tag; the committed version stays the release floor.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const version = process.argv[2] || '';
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Usage: node scripts/stamp-version.mjs X.Y.Z');
const packagePath = path.join(root, 'package.json');
const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
manifest.version = version;
fs.writeFileSync(packagePath, JSON.stringify(manifest, null, 2) + '\n');
const zonPath = path.join(root, 'app/app.zon');
const zon = fs.readFileSync(zonPath, 'utf8');
const stamped = zon.replace(/^(\s*\.version = ")[^"]+(",)$/m, `$1${version}$2`);
if (stamped === zon && !zon.includes(`.version = "${version}",`)) throw new Error('app/app.zon has no .version field to stamp.');
fs.writeFileSync(zonPath, stamped);
console.log(`Stamped version ${version}`);
