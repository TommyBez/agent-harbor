import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../broker/store.mjs';
import { importEvents } from '../../broker/events.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-journal-review-'));
  const store = new Store(path.join(home, 'state.sqlite'));
  t.after(() => { store.close(); fs.rmSync(home, { recursive: true, force: true }); });
  store.run('INSERT INTO sessions(id,title,provider,project,owner,status,native_id,run_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', 'session', 'Fixture', 'codex', '/fixture', 'grok', 'stopped', 'native', 'run', '2026-01-01', '2026-01-01');
  store.run('INSERT INTO runs(id,session_id,tmux_name,started_at) VALUES(?,?,?,?)', 'run', 'session', 'harbor-run', '2026-01-01');
  fs.mkdirSync(path.join(home, 'runs/run'), { recursive: true });
  return { store, config: { home }, filename: path.join(home, 'runs/run/events.jsonl'), read: () => importEvents(store, { home }, store.runRecord('run')) };
}
function measuredReads(fn) {
  const original = fs.readSync; let bytes = 0;
  fs.readSync = function (...args) { const read = original(...args); bytes += read; return read; };
  try { fn(); return bytes; } finally { fs.readSync = original; }
}

test('a journal import processes at most 8 MiB and unchanged history is not reread', t => {
  const { store, filename, read } = fixture(t);
  const entries = Array.from({ length: 200 }, (_, index) => JSON.stringify({ sessionId: 'session', runId: 'run', provider: 'codex', time: '2026-01-01T00:00:00Z', event: { session_id: 'native', cwd: '/fixture', hook_event_name: 'SessionEnd', note: `${index}:` + 'x'.repeat(50000) } }) + '\n');
  fs.writeFileSync(filename, entries.join(''));
  assert.ok(fs.statSync(filename).size > 8 * 1024 * 1024);
  const firstRead = measuredReads(read);
  assert.ok(firstRead > 0 && firstRead <= 8 * 1024 * 1024);
  const imported = store.get('SELECT count(*) AS count FROM events').count;
  assert.ok(imported > 0 && imported < 200, 'The importer must yield before processing an unbounded journal.');
  measuredReads(read);
  assert.equal(store.get('SELECT count(*) AS count FROM events').count, 200);
  assert.equal(measuredReads(read), 0, 'Previously imported bytes must not be reread on each poll.');
});

test('an oversized incomplete journal is quarantined without repeated reads or audit spam', t => {
  const { store, filename, read } = fixture(t);
  fs.writeFileSync(filename, 'x'.repeat(4 * 1024 * 1024 + 1));
  assert.ok(measuredReads(read) > 0);
  assert.equal(store.runRecord('run').attention, 'HOOK_EVENT_TOO_LARGE');
  const before = store.get('SELECT count(*) AS count FROM audit').count;
  const reread = measuredReads(() => { for (let index = 0; index < 4; index++) read(); });
  assert.equal(reread, 0, 'A quarantined run must not repeatedly read the same corrupt multi-megabyte data.');
  assert.equal(store.get('SELECT count(*) AS count FROM audit').count, before, 'The same corruption must not grow the audit log forever.');
});
