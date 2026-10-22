import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configuration, ensurePrivateHome } from '../../broker/common.mjs';
import { Store } from '../../broker/store.mjs';
import { Service } from '../../broker/service.mjs';
import { acceptEvent } from '../../broker/events.mjs';

// tmux pane IDs are unique only for one server lifetime. After a reboot or kill-server the private server numbers
// panes from %0 again, so a stored pane ID can name another session's pane.
class RestartingTmux {
  active = new Map(); screens = new Map(); launches = []; calls = []; next = 0; restartOnLaunch = false; restartedAt = 0;
  panes() { return new Map(this.active); }
  restart() { this.active.clear(); this.screens.clear(); this.next = 0; this.restartedAt = this.calls.length; }
  launch(run, session, command) {
    // The server restarts after Harbor last listed panes, before this launch.
    if (this.restartOnLaunch) { this.restartOnLaunch = false; this.restart(); }
    const paneId = '%' + this.next++, pid = 1000 + this.launches.length;
    this.launches.push({ run, session, command });
    this.active.set(paneId, { id: paneId, pid, name: run.tmux_name, alive: true, windowIndex: 0, paneIndex: 0 });
    return { paneId, pid };
  }
  // Every input and capture, with the tmux session that owns the targeted pane.
  use(kind, run, value) { this.calls.push({ kind, runId: run.id, pane: run.pane_id, session: run.tmux_name, owner: this.active.get(run.pane_id)?.name, value }); }
  crossed() { return this.calls.filter(call => call.owner !== call.session); }
  // Calls for a run since the server restarted; before that its own pane was alive.
  callsFor(runId) { return this.calls.slice(this.restartedAt).filter(call => call.runId === runId); }
  paste(run, text) { this.use('paste', run, text); }
  async pasteImages(run, images, check) { check(); this.use('pasteImages', run); }
  enter(run) { this.use('enter', run); }
  key(run, name) { this.use('key', run, name); }
  exit(run) { this.use('exit', run); }
  capture(run) { this.use('capture', run); return this.screens.get(run.pane_id) ?? ''; }
  screen(run) { this.use('screen', run); return this.screens.get(run.pane_id) ?? ''; }
  enforce() { return 0; }
  syncOwnership() {}
  removeDeadSession() { return false; }
  args() { return []; }
}

function environment() {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'harbor-panes-'));
  const config = configuration({ ...process.env, HARBOR_HOME: home });
  config.executables = { codex: process.execPath, claude: process.execPath };
  ensurePrivateHome(config);
  const store = new Store(config.database), tmux = new RestartingTmux();
  return { home, store, tmux, service: new Service(config, store, tmux), cleanup: () => { store.close(); fs.rmSync(home, { recursive: true, force: true }); } };
}
function event(store, id, event, offset) {
  const s = store.session(id), run = store.runRecord(s.run_id);
  acceptEvent(store, run, { sessionId: id, runId: run.id, provider: s.provider, event: { cwd: s.project, session_id: s.native_id, ...event } }, offset);
}
// A started Claude session whose first task finished: ready for the bot to send.
async function readySession(e, requestId) {
  const id = (await e.service.execute('create', { provider: 'claude', project: e.home, owner: 'grok', text: 'First task', requestId })).session.id;
  event(e.store, id, { hook_event_name: 'SessionStart' }, 0);
  event(e.store, id, { hook_event_name: 'UserPromptSubmit', prompt_id: 'turn', prompt: 'First task' }, 1);
  event(e.store, id, { hook_event_name: 'Stop', prompt_id: 'turn', last_assistant_message: 'done' }, 2);
  assert.equal(e.store.session(id).status, 'ready');
  return id;
}
const UPDATE_SCREEN = '  Update available · 1.0.0 → 1.0.1\n› 1. Update now\n  2. Skip\n  3. Skip until next version\n  enter continue · esc skip';
const folderScreen = folder => `  Folder access\n  ${folder}\n  Trust this folder?\n› 1. Trust and continue\n  2. Back\n  enter continue · esc back`;

test('a stopped session never adopts the pane that reuses its ID after a tmux restart', async () => {
  const e = environment();
  try {
    const a = await readySession(e, 'a-first');
    const runA = e.store.runRecord(e.store.session(a).run_id);
    assert.equal(runA.pane_id, '%0');
    e.tmux.restart();
    e.service.refresh();
    assert.equal(e.store.session(a).status, 'stopped');
    const endedA = e.store.runRecord(runA.id);
    assert.ok(endedA.ended_at);
    const b = (await e.service.execute('create', { provider: 'claude', project: e.home, owner: 'human', text: 'Other task', requestId: 'b-first' })).session;
    assert.equal(e.store.runRecord(b.runId).pane_id, '%0', 'tmux numbered the new pane like the old one');
    e.tmux.screens.set('%0', 'session B private screen');
    const listed = (await e.service.execute('list', {})).sessions.find(s => s.id === a);
    assert.equal(listed.alive, false);
    assert.equal(listed.status, 'stopped');
    assert.equal(listed.pid, endedA.pid);
    assert.deepEqual(e.store.runRecord(runA.id), endedA, 'The ended run keeps its pid and pane ID.');
    assert.equal((await e.service.execute('capture', { id: a })).screen, '');
    await assert.rejects(e.service.execute('send', { id: a, actor: 'grok', text: 'For A only', requestId: 'a-send' }), { code: 'SESSION_STOPPED' });
    assert.equal((await e.service.execute('stop', { id: a, actor: 'grok' })).session.alive, false);
    assert.deepEqual(e.tmux.callsFor(runA.id), []);
    const resumed = await e.service.execute('resume', { id: a, actor: 'grok' });
    assert.notEqual(resumed.session.runId, runA.id);
    assert.equal(e.tmux.launches.length, 3);
    assert.equal(resumed.session.nativeSessionId, e.store.session(a).native_id);
    assert.equal(e.store.runRecord(resumed.session.runId).pane_id, '%1');
    assert.equal((await e.service.execute('list', {})).sessions.find(s => s.id === b.id).alive, true);
    assert.deepEqual(e.tmux.crossed(), []);
  } finally { e.cleanup(); }
});

test('a live run whose pane vanished in a restart is stopped, not redirected to the new %0', async () => {
  const e = environment();
  try {
    const a = await readySession(e, 'a-first');
    const runA = e.store.runRecord(e.store.session(a).run_id);
    e.tmux.restartOnLaunch = true;
    const b = (await e.service.execute('create', { provider: 'claude', project: e.home, owner: 'human', text: 'Other task', requestId: 'b-first' })).session;
    assert.equal(e.store.runRecord(b.runId).pane_id, runA.pane_id);
    const current = e.service.describe(a);
    assert.equal(current.alive, false);
    assert.equal(current.status, 'stopped');
    assert.ok(e.store.runRecord(runA.id).ended_at);
    await assert.rejects(e.service.execute('send', { id: a, actor: 'grok', text: 'For A only', requestId: 'a-send' }), { code: 'SESSION_STOPPED' });
    assert.equal(e.store.request(a, 'a-send'), undefined);
    assert.equal((await e.service.execute('stop', { id: a, actor: 'grok' })).session.alive, false);
    assert.deepEqual(e.tmux.callsFor(runA.id), []);
    assert.deepEqual(e.tmux.crossed(), []);
  } finally { e.cleanup(); }
});

test('an ended run sends no startup or trust keys to the pane that reuses its ID', async () => {
  const e = environment();
  try {
    // A bot-started Codex CLI that exited before its hooks reported.
    const a = (await e.service.execute('create', { provider: 'codex', project: e.home, owner: 'grok', text: 'First task', requestId: 'a-first' })).session.id;
    const runA = e.store.runRecord(e.store.session(a).run_id);
    e.tmux.restart();
    e.service.refresh();
    assert.equal(e.store.session(a).status, 'stopped');
    const b = (await e.service.execute('create', { provider: 'codex', project: e.home, owner: 'human', text: 'Other task', requestId: 'b-first' })).session;
    assert.equal(e.store.runRecord(b.runId).pane_id, runA.pane_id);
    e.tmux.screens.set('%0', UPDATE_SCREEN);
    e.service.refresh();
    e.tmux.screens.set('%0', folderScreen(e.home));
    e.service.refresh();
    await assert.rejects(e.service.execute('trust', { id: a }), { code: 'TRUST_PROMPT_ABSENT' });
    assert.equal(e.service.describe(a).alive, false);
    assert.equal(e.store.session(a).error, null);
    assert.deepEqual(e.tmux.callsFor(runA.id), []);
    assert.deepEqual(e.tmux.calls.filter(call => call.kind === 'key'), []);
    assert.equal(e.store.get("SELECT 1 FROM audit WHERE session_id = ? AND action = 'update_notice_skipped'", a), undefined);
    assert.deepEqual(e.tmux.crossed(), []);
  } finally { e.cleanup(); }
});

test('a malformed legacy pane ID is recovered only from the run\'s own primary pane and recorded', async () => {
  const e = environment();
  try {
    const a = await readySession(e, 'a-first');
    const runA = e.store.runRecord(e.store.session(a).run_id);
    // Written under a non-UTF-8 locale, where tmux showed the tab separator as '_'.
    e.store.run('UPDATE runs SET pane_id = ? WHERE id = ?', '%0_1000', runA.id);
    e.service.refresh();
    assert.equal(e.service.describe(a).alive, true);
    assert.equal(e.store.runRecord(runA.id).pane_id, '%0');
    e.tmux.restartOnLaunch = true;
    const b = (await e.service.execute('create', { provider: 'claude', project: e.home, owner: 'human', text: 'Other task', requestId: 'b-first' })).session;
    assert.deepEqual(e.tmux.active.get(e.store.runRecord(b.runId).pane_id), { id: '%0', pid: 1001, name: e.store.runRecord(b.runId).tmux_name, alive: true, windowIndex: 0, paneIndex: 0 });
    // A legacy run still recorded as live must not take another session's primary pane.
    e.store.run('UPDATE runs SET pane_id = ?, ended_at = NULL WHERE id = ?', '%0_1000', runA.id);
    assert.equal(e.service.describe(a).alive, false);
    e.service.refresh();
    assert.ok(e.store.runRecord(runA.id).ended_at);
    assert.equal(e.store.runRecord(runA.id).pane_id, '%0_1000');
    assert.deepEqual(e.tmux.crossed(), []);
  } finally { e.cleanup(); }
});
