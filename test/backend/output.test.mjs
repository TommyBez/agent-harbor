import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotLines } from '../../broker/output.mjs';

test('1,000 metadata sessions stream in bounded lines and reconstruct one atomic snapshot', () => {
  const sessions = Array.from({ length: 1000 }, (_, index) => ({ id: String(index), title: 'Sessione con Unicode 你好 🌊 ' + index, provider: index % 2 ? 'claude' : 'codex', project: '/project/' + 'a'.repeat(200), owner: 'human', status: 'stopped', nativeSessionId: null, pending: false, error: null }));
  const lines = [...snapshotLines({ ok: true, sessions })];
  assert.ok(lines.length > 3);
  for (const line of lines) assert.ok(Buffer.byteLength(line) <= 100 * 1024);
  const frames = lines.map(line => JSON.parse(line));
  assert.equal(frames[0].type, 'snapshot-begin');
  assert.equal(frames[0].count, 1000);
  assert.equal(frames.at(-1).type, 'snapshot-end');
  assert.ok(frames.every(frame => frame.snapshotId === frames[0].snapshotId));
  assert.deepEqual(frames.slice(1, -1).flatMap(frame => frame.sessions), sessions);
  const next = JSON.parse([...snapshotLines({ sessions: [] })][0]);
  assert.notEqual(next.snapshotId, frames[0].snapshotId);
});
