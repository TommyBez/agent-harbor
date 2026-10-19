import test from 'node:test';
import assert from 'node:assert/strict';
import { latestTag, nextVersion } from '../../scripts/next-version.mjs';
import { affectsApp, releaseScope } from '../../scripts/release-scope.mjs';

test('release versions start at the source floor and bump the newest tag', () => {
  assert.equal(nextVersion('0.1.0', [], 'patch'), '0.1.0');
  assert.equal(nextVersion('0.1.0', ['v0.1.0'], 'patch'), '0.1.1');
  assert.equal(nextVersion('0.1.0', ['v0.1.9', 'v0.1.10', 'v0.1.2'], 'patch'), '0.1.11');
  assert.equal(nextVersion('0.1.0', ['v0.1.4'], 'minor'), '0.2.0');
  assert.equal(nextVersion('0.1.0', ['v0.3.4'], 'major'), '1.0.0');
  // Raising the source version above the latest tag jumps straight to it.
  assert.equal(nextVersion('0.5.0', ['v0.1.4'], 'patch'), '0.5.0');
  // Unrelated or malformed tags are ignored.
  assert.equal(nextVersion('0.1.0', ['nightly', 'v1', 'v0.1.0-rc.1', 'v0.1.0'], 'patch'), '0.1.1');
  assert.throws(() => nextVersion('0.1.0', [], 'huge'), /Invalid bump/);
  assert.throws(() => nextVersion('banana', [], 'patch'), /Invalid source version/);
});

test('only changes to shipped application files trigger a release', () => {
  for (const file of ['app/src/main.zig', 'app/src/app.native', 'app/app.zon', 'app/assets/icon.svg', 'broker/tmux.mjs', 'broker/hooks/observe.mjs', 'bin/harbor.mjs', 'scripts/gui.mjs', 'scripts/package.mjs', 'scripts/dmg.mjs', 'package.json', 'pnpm-lock.yaml', 'LICENSE']) assert.equal(affectsApp(file), true, file);
  for (const file of ['README.md', 'docs/RELEASING.md', 'skills/agent-harbor/SKILL.md', 'test/backend/release.test.mjs', 'app/src/tests.zig', 'app/README.md', '.github/workflows/release.yml', '.agents/skills/core/SKILL.md', 'scripts/check.mjs', 'scripts/release-scope.mjs', 'AGENTS.md', 'application.txt', 'broker']) assert.equal(affectsApp(file), false, file);
  const diff = files => () => files;
  assert.deepEqual(releaseScope('HEAD', [], diff([])), { base: null, changed: true, files: [] });
  assert.deepEqual(releaseScope('HEAD', ['v0.1.0', 'v0.1.2'], diff(['docs/a.md', 'skills/x/SKILL.md'])), { base: 'v0.1.2', changed: false, files: [] });
  assert.deepEqual(releaseScope('HEAD', ['v0.1.0'], diff(['README.md', 'broker/service.mjs'])), { base: 'v0.1.0', changed: true, files: ['broker/service.mjs'] });
  assert.equal(latestTag(['v0.1.9', 'v0.1.10', 'nightly', 'v0.2.0-rc.1']), 'v0.1.10');
});
