import test from 'node:test';
import assert from 'node:assert/strict';
import { nextVersion } from '../../scripts/next-version.mjs';

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
