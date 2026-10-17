import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../../broker/store.mjs';
import { Service } from '../../broker/service.mjs';
import { rpc } from '../../broker/client.mjs';
import { configuration } from '../../broker/common.mjs';

function temporaryHome(t) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'harbor-scale-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
function seed(store, count) {
  store.transaction(() => {
    for (let index = 0; index < count; index++) {
      store.run('INSERT INTO sessions(id,title,provider,project,owner,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', randomUUID(), `Synthetic session ${index}`, index % 2 ? 'codex' : 'claude', '/synthetic/fixture', 'grok', 'stopped', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    }
  });
}
const rounded = value => Math.round(value * 100) / 100;
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))];

for (const count of [250, 1000]) {
  test(`${count} stored sessions: compact snapshots remain isolated and issue constant tmux queries`, async t => {
    const home = temporaryHome(t); const config = configuration({ HARBOR_HOME: home });
    const store = new Store(config.database); t.after(() => store.close());
    seed(store, count);
    let paneQueries = 0, ownershipQueries = 0;
    const tmux = { panes() { paneQueries++; return new Map(); }, syncOwnership() { ownershipQueries++; }, args() { throw new Error('No terminal should be attached for a compact snapshot.'); } };
    const service = new Service(config, store, tmux);
    await service.execute('list', { compact: true });
    const timings = [];
    for (let index = 0; index < 12; index++) {
      const before = performance.now(); const snapshot = await service.execute('list', { compact: true }); timings.push(performance.now() - before);
      assert.equal(snapshot.sessions.length, count);
      assert.equal(new Set(snapshot.sessions.map(session => session.id)).size, count);
      assert.ok(snapshot.sessions.every(session => !('lastResponse' in session) && !('terminal' in session)));
      assert.equal(paneQueries, index + 2); assert.equal(ownershipQueries, index + 2);
    }
    const metrics = { storedSessions: count, repetitions: timings.length, listCompactMs: { median: rounded(percentile(timings, 0.5)), p95: rounded(percentile(timings, 0.95)) }, tmuxQueriesPerSnapshot: 2, agentProcessesStarted: 0 };
    // A broad CI guard catches accidental quadratic work or a multi-second stall.
    // Published measurements, not this threshold, describe actual performance.
    assert.ok(metrics.listCompactMs.p95 < 2000, `Compact metadata snapshot stalled: ${metrics.listCompactMs.p95} ms`);
    t.diagnostic(JSON.stringify(metrics));
    if (process.env.HARBOR_BENCHMARK_REPORT) {
      const filename = process.env.HARBOR_BENCHMARK_REPORT;
      const prior = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : { node: process.version, measurements: [] };
      prior.measurements.push(metrics);
      fs.writeFileSync(filename, JSON.stringify(prior, null, 2) + '\n', { mode: 0o600 });
    }
  });
}

test('a watch over 1000 records sends no unchanged snapshots and polls tmux independently of row count', { timeout: 15000 }, async t => {
  const home = temporaryHome(t); const fakeTmux = path.join(home, 'tmux-stub.mjs');
  fs.writeFileSync(fakeTmux, `#!${process.execPath}\nimport fs from 'node:fs';\nimport path from 'node:path';\nconst args=process.argv.slice(2);\nconst command=args[2];\nfs.appendFileSync(path.join(process.env.HARBOR_HOME,'tmux-queries.jsonl'),JSON.stringify({command,time:Date.now()})+'\\n',{mode:0o600});\nif(!['list-panes','list-clients'].includes(command)){process.stderr.write('Unexpected command; this test never launches a CLI.');process.exitCode=1;}\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ executables: { tmux: fakeTmux } }), { mode: 0o600 });
  const config = configuration({ ...process.env, HARBOR_HOME: home });
  const store = new Store(config.database); seed(store, 1000); store.close();
  const snapshots = []; let daemonPid;
  const watch = rpc('watch', { compact: true }, { config, onEvent: value => snapshots.push(value) });
  try {
    const deadline = Date.now() + 5000;
    while (!snapshots.length && Date.now() < deadline) await delay(20);
    assert.equal(snapshots.length, 1, 'The watch must receive its initial state.');
    assert.equal(snapshots[0].sessions.length, 1000);
    daemonPid = JSON.parse(fs.readFileSync(path.join(home, 'daemon.lock/owner.json'), 'utf8')).pid;
    await delay(3200);
    assert.equal(snapshots.length, 1, 'Unchanged metadata must not be retransmitted every tick.');
    const queries = fs.readFileSync(path.join(home, 'tmux-queries.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(queries.every(query => ['list-panes', 'list-clients'].includes(query.command)));
    assert.ok(queries.length >= 6 && queries.length <= 14, `Expected constant server polling, observed ${queries.length} subprocesses.`);
    assert.equal(fs.statSync(config.socket).mode & 0o777, 0o600);
    for (const filename of [config.database, config.database + '-wal', config.database + '-shm']) {
      assert.equal(fs.statSync(filename).mode & 0o777, 0o600, `Private database mode: ${path.basename(filename)}`);
    }
    t.diagnostic(JSON.stringify({ watchedSessions: 1000, observationMs: 3200, snapshotsReceived: snapshots.length, tmuxSubprocesses: queries.length, agentProcessesStarted: 0 }));
  } finally {
    daemonPid ||= (() => { try { return JSON.parse(fs.readFileSync(path.join(home, 'daemon.lock/owner.json'), 'utf8')).pid; } catch { return null; } })();
    if (daemonPid) { try { process.kill(daemonPid, 'SIGTERM'); } catch {} }
    await watch.catch(() => {});
    await delay(100);
  }
});

test('busy human ownership cannot be released through the metadata controller', async t => {
  const home = temporaryHome(t); const config = configuration({ HARBOR_HOME: home });
  const store = new Store(config.database); t.after(() => store.close());
  const id = randomUUID();
  store.run('INSERT INTO sessions(id,title,provider,project,owner,status,pending,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', id, 'Human turn', 'codex', '/synthetic/fixture', 'human', 'running', 1, '2026-01-01', '2026-01-01');
  const tmux = { panes: () => new Map(), syncOwnership() {} };
  const service = new Service(config, store, tmux);
  await assert.rejects(service.execute('control', { id, owner: 'grok', actor: 'human' }), { code: 'TURN_PENDING' });
  assert.equal(store.session(id).owner, 'human');
  assert.equal(store.session(id).control_epoch, 0);
  store.run('UPDATE sessions SET pending = 0, closing = 1 WHERE id = ?', id);
  await assert.rejects(service.execute('control', { id, owner: 'grok', actor: 'human' }), { code: 'TURN_PENDING' });
  store.run("UPDATE sessions SET closing = 0, status = 'ready' WHERE id = ?", id);
  const released = await service.execute('control', { id, owner: 'grok', actor: 'human' });
  assert.equal(released.session.owner, 'grok');
  assert.equal(store.session(id).control_epoch, 1);
});
