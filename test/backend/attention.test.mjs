import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../../broker/store.mjs';
import { Service } from '../../broker/service.mjs';
import { acceptEvent } from '../../broker/events.mjs';
import { rpc } from '../../broker/client.mjs';
import { configuration, executable, hashPrompt } from '../../broker/common.mjs';

// Sessions that are working normally must never look like they need a human.
function fixture(t, provider = 'claude', cliArgs = '[]') {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'harbor-attention-'));
  const project = path.join(home, 'project'); fs.mkdirSync(path.join(project, 'episodes', 'one'), { recursive: true });
  const store = new Store(path.join(home, 'state.sqlite'));
  t.after(() => { store.close(); fs.rmSync(home, { recursive: true, force: true }); });
  store.run('INSERT INTO sessions(id,title,provider,project,cli_args,owner,status,native_id,run_id,pending,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', 'session', 'Fixture', provider, project, cliArgs, 'grok', 'starting', 'native', 'run', 1, '2026-01-01', '2026-01-01');
  store.run('INSERT INTO runs(id,session_id,tmux_name,started_at) VALUES(?,?,?,?)', 'run', 'session', 'harbor-run', '2026-01-01');
  const request = (id, text) => store.run('INSERT INTO requests(session_id,request_id,run_id,prompt_hash,payload_hash,status,actor,created_at,transport) VALUES(?,?,?,?,?,?,?,?,?)', 'session', id, 'run', hashPrompt(text), hashPrompt(text), 'awaiting_ack', 'grok', new Date().toISOString(), 'terminal-paste');
  request('request', 'Task');
  let offset = 0, turn = 'turn';
  const emit = (event, extra = {}) => acceptEvent(store, store.runRecord('run'), { sessionId: 'session', runId: 'run', provider, time: extra.time || new Date().toISOString(),
    event: { session_id: 'native', cwd: project, [provider === 'codex' ? 'turn_id' : 'prompt_id']: turn, hook_event_name: event, ...extra } }, ++offset);
  return { home, project, store, emit, request, setTurn: value => { turn = value; }, session: () => store.session('session'), receipt: id => store.request('session', id) };
}

test('a cd into a subdirectory after the run is established is normal, including its Stop', t => {
  const { project, store, emit, session, receipt } = fixture(t);
  emit('SessionStart');
  emit('UserPromptSubmit', { prompt: 'Task' });
  emit('PostToolUse', { tool_name: 'Bash', cwd: path.join(project, 'episodes', 'one') });
  assert.equal(store.runRecord('run').attention, null);
  assert.equal(session().status, 'running');
  emit('Stop', { last_assistant_message: 'Rendered', cwd: path.join(project, 'episodes', 'one') });
  assert.equal(receipt('request').status, 'completed');
  assert.equal(receipt('request').response, 'Rendered');
  assert.equal(session().status, 'ready');
  // Outside the project too (an --add-dir folder): only identity matters once the run is established.
  emit('UserPromptSubmit', { prompt: 'Other' });
  emit('PostToolUse', { tool_name: 'Bash', cwd: os.tmpdir() });
  assert.equal(session().status, 'running');
  assert.equal(session().working_directory, null, 'A moved shell never becomes the resume directory.');
  // Codex keeps one cwd per session, so a different one there is still an anomaly.
  const codex = fixture(t, 'codex');
  codex.emit('SessionStart'); codex.emit('UserPromptSubmit', { prompt: 'Task' });
  codex.emit('PostToolUse', { tool_name: 'shell', cwd: path.join(codex.project, 'episodes') });
  assert.equal(codex.store.runRecord('run').attention, 'HOOK_PROJECT_MISMATCH');
});

test('the first event of a run must still come from the launch directory', t => {
  const { project, store, emit, session } = fixture(t);
  emit('SessionStart', { cwd: path.join(project, 'episodes') });
  assert.equal(store.runRecord('run').attention, 'HOOK_PROJECT_MISMATCH');
  assert.equal(session().error, 'HOOK_PROJECT_MISMATCH');
});

test('a worktree is learned only from the root of a linked checkout, never from a folder inside the project', t => {
  const { home, project, store, emit, session } = fixture(t, 'claude', '["--worktree"]');
  const git = args => execFileSync('git', ['-C', project, ...args], { stdio: 'ignore' });
  git(['init', '-q']); git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  emit('SessionStart', { cwd: path.join(project, 'episodes') });
  assert.equal(session().working_directory, null);
  assert.equal(store.runRecord('run').attention, 'HOOK_PROJECT_MISMATCH');
  const tree = path.join(home, 'tree');
  git(['worktree', 'add', '-q', '--detach', tree]);
  store.run('UPDATE runs SET attention = NULL WHERE id = ?', 'run');
  emit('SessionStart', { cwd: tree });
  assert.equal(session().working_directory, fs.realpathSync(tree));
});

test('Claude asks for attention only when its own permission dialog waits, and clears when the tool moves on', t => {
  const { emit, session } = fixture(t);
  emit('SessionStart');
  emit('UserPromptSubmit', { prompt: 'Task' });
  emit('PermissionRequest', { tool_name: 'Bash' });
  assert.equal(session().status, 'running', 'A hook or auto mode may answer this request; nothing waits for a human yet.');
  emit('Notification', { notification_type: 'permission_prompt' });
  assert.equal(session().status, 'attention');
  assert.equal(session().error, 'PERMISSION_REQUIRED');
  emit('PostToolUseFailure', { tool_name: 'Bash' });
  assert.equal(session().status, 'running', 'A failed tool still shows the human answered.');
  emit('Notification', { notification_type: 'permission_prompt' });
  emit('PermissionDenied', { tool_name: 'Bash' });
  assert.equal(session().status, 'running');
  emit('Notification', { notification_type: 'idle_prompt' });
  assert.equal(session().status, 'running', 'Idle notices are not requests for a decision.');
  emit('Notification', { notification_type: 'elicitation_url_dialog' });
  assert.equal(session().error, 'CLI_ATTENTION_REQUIRED');
});

test('after an interrupt or a transient API error the CLI is ready; account problems still need the human', t => {
  const codex = fixture(t, 'codex');
  codex.emit('SessionStart'); codex.emit('UserPromptSubmit', { prompt: 'Task' }); codex.emit('Interrupt');
  assert.equal(codex.receipt('request').status, 'interrupted');
  assert.equal(codex.session().status, 'ready');
  assert.equal(codex.session().pending, 0);
  // rate_limit can open Claude's usage-limit menu or an auto-continue wait; invalid_request covers a context that needs /compact.
  for (const [error, expected] of [['overloaded', 'ready'], [{ type: 'server_error' }, 'ready'], ['max_output_tokens', 'ready'], ['rate_limit', 'attention'], ['invalid_request', 'attention'], ['billing_error', 'attention'], ['authentication_failed', 'attention'], [undefined, 'attention']]) {
    const claude = fixture(t);
    claude.emit('SessionStart'); claude.emit('UserPromptSubmit', { prompt: 'Task' }); claude.emit('StopFailure', { error });
    assert.equal(claude.receipt('request').status, 'failed', JSON.stringify(error));
    if (error) assert.match(claude.receipt('request').error, new RegExp(typeof error === 'string' ? error : error.type), 'The request keeps the failure.');
    assert.equal(claude.session().status, expected, JSON.stringify(error));
    assert.equal(claude.session().error, expected === 'ready' ? null : 'STOPFAILURE');
  }
});

test('scheduled crons do not hold a finished turn open; running background tasks still do', t => {
  const { emit, session, receipt } = fixture(t);
  emit('SessionStart'); emit('UserPromptSubmit', { prompt: 'Task' });
  emit('Stop', { last_assistant_message: 'Scheduled', session_crons: [{ id: 'hourly', recurring: true }] });
  assert.equal(receipt('request').status, 'completed');
  assert.equal(session().pending, 0);
  const other = fixture(t);
  other.emit('SessionStart'); other.emit('UserPromptSubmit', { prompt: 'Task' });
  other.emit('Stop', { last_assistant_message: 'Waiting', background_tasks: [{ id: 'worker' }] });
  assert.equal(other.session().pending, 1);
});

test('a new Claude prompt after an unobserved interrupt ends the old request instead of leaving it running', t => {
  const { emit, setTurn, request, receipt, session } = fixture(t);
  emit('SessionStart'); emit('UserPromptSubmit', { prompt: 'Task' }); emit('PostToolUse', { tool_name: 'Read' });
  request('next', 'Human follow-up');
  setTurn('turn-2');
  emit('UserPromptSubmit', { prompt: 'Human follow-up' });
  assert.equal(receipt('request').status, 'interrupted');
  assert.equal(receipt('request').error, 'TURN_SUPERSEDED');
  assert.equal(receipt('next').status, 'running');
  assert.equal(session().active_turn, 'turn-2');
  // A Stop with background work is a real end of turn; a later prompt must not rewrite that request.
  const other = fixture(t);
  other.emit('SessionStart'); other.emit('UserPromptSubmit', { prompt: 'Task' });
  other.emit('Stop', { last_assistant_message: 'Waiting', background_tasks: [{ id: 'worker' }] });
  other.setTurn('turn-2'); other.emit('UserPromptSubmit', { prompt: 'Later' });
  assert.equal(other.receipt('request').status, 'running');
});

function service(store, config) {
  const panes = new Map([['%1', { id: '%1', name: 'harbor-run', pid: process.pid, alive: true, windowIndex: 0, paneIndex: 0 }]]);
  store.run("UPDATE runs SET pane_id = '%1', pid = ? WHERE id = 'run'", process.pid);
  const tmux = { binary: '/bin/echo', args: () => [], capture: () => '', screen: () => '', syncOwnership() {}, removeDeadSession: () => false, panes: () => panes };
  return new Service({ env: process.env, executables: {}, startupTimeout: 30000, stopTimeout: 20000, ...config }, store, tmux);
}

test('a Codex PermissionRequest becomes attention only if the CLI stays silent past the grace period', t => {
  const { home, store, emit, session } = fixture(t, 'codex');
  emit('SessionStart'); emit('UserPromptSubmit', { prompt: 'Task' });
  emit('PermissionRequest', { tool_name: 'shell' });
  const svc = service(store, { home });
  svc.refresh();
  assert.equal(session().status, 'running', 'A reviewer or hook may still answer it.');
  store.run("UPDATE events SET time = ? WHERE event_name = 'PermissionRequest'", new Date(Date.now() - 10000).toISOString());
  svc.refresh();
  assert.equal(session().status, 'attention');
  assert.equal(session().error, 'PERMISSION_REQUIRED');
  emit('PostToolUse', { tool_name: 'shell' });
  svc.refresh();
  assert.equal(session().status, 'running');
});

test('acknowledgement age counts from this run\'s delivery, and an uncertain delivery stays flagged after later prompts', t => {
  const { home, store, emit, session } = fixture(t);
  const old = new Date(Date.now() - 3600_000).toISOString();
  store.run("UPDATE requests SET created_at = ?, delivered_at = ? WHERE request_id = 'request'", old, new Date().toISOString());
  store.run('UPDATE runs SET started_at = ? WHERE id = ?', new Date().toISOString(), 'run');
  emit('SessionStart');
  const svc = service(store, { home, startupTimeout: 1000 });
  svc.refresh();
  assert.equal(session().error, null, 'A relaunched request is not an hour late.');
  store.run('UPDATE runs SET started_at = ? WHERE id = ?', old, 'run');
  store.run('UPDATE requests SET delivered_at = ? WHERE request_id = ?', old, 'request');
  svc.refresh();
  assert.equal(session().error, 'PROMPT_NOT_ACKNOWLEDGED', 'An old delivery in this run still asks the human to check.');
  store.run("UPDATE requests SET status = 'uncertain', delivered_at = NULL WHERE request_id = 'request'");
  store.run("UPDATE sessions SET status = 'running', error = NULL WHERE id = 'session'");
  svc.refresh();
  assert.equal(session().error, 'DELIVERY_UNCERTAIN', 'An unresolved delivery is named accurately.');
  emit('UserPromptSubmit', { prompt: 'Human typed something else' });
  svc.refresh();
  assert.equal(session().error, 'DELIVERY_UNCERTAIN', 'A different prompt does not resolve it; the human must check what arrived.');
});

// Recreates what releases up to 0.1.3 left behind: a journal whose events after Claude's cd were dropped, the offset past them.
function legacyRun(t, provider, lines, accepted, incidentAt, attention = 'HOOK_PROJECT_MISMATCH') {
  const f = fixture(t, provider);
  const journal = path.join(f.home, 'runs', 'run', 'events.jsonl');
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  const offsets = [], entries = []; let bytes = '';
  for (const event of lines(f.project)) {
    const entry = { time: new Date().toISOString(), sessionId: 'session', runId: 'run', provider, event: { session_id: 'native', cwd: f.project, [provider === 'codex' ? 'turn_id' : 'prompt_id']: 'turn', ...event } };
    offsets.push(Buffer.byteLength(bytes)); entries.push(entry); bytes += JSON.stringify(entry) + '\n';
  }
  fs.writeFileSync(journal, bytes);
  for (const index of accepted.filter(index => index < incidentAt)) acceptEvent(f.store, f.store.runRecord('run'), entries[index], offsets[index]);
  f.store.audit('HOOK_PROJECT_MISMATCH', 'session', { runId: 'run', offset: offsets[incidentAt] });
  f.store.run("UPDATE runs SET attention = 'HOOK_PROJECT_MISMATCH' WHERE id = 'run'");
  for (const index of accepted.filter(index => index > incidentAt)) acceptEvent(f.store, f.store.runRecord('run'), entries[index], offsets[index]);
  f.store.run('UPDATE runs SET offset = ?, attention = ?, hooks_ready = 1 WHERE id = ?', Buffer.byteLength(bytes), attention, 'run');
  f.store.run("UPDATE sessions SET status = 'attention', error = ? WHERE id = 'session'", attention);
  return { ...f, journal };
}

test('a legacy cwd incident whose Stop was dropped is cleared but shown as unconfirmed until the CLI speaks again', t => {
  const f = legacyRun(t, 'claude', project => [{ hook_event_name: 'SessionStart' }, { hook_event_name: 'UserPromptSubmit', prompt: 'Task' },
    { hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: path.join(project, 'episodes', 'one') }, { hook_event_name: 'Stop', last_assistant_message: 'The real answer', cwd: path.join(project, 'episodes', 'one') }], [0, 1], 2);
  const svc = service(f.store, { home: f.home });
  svc.recoverCwdIncidents();
  svc.refresh();
  assert.equal(f.store.runRecord('run').attention, null, 'The sticky marker is gone, so new events count.');
  assert.equal(f.session().status, 'attention');
  assert.equal(f.session().error, 'TURN_STATE_UNKNOWN', 'Harbor never invents the lost result.');
  assert.equal(f.store.runRecord('run').offset, fs.statSync(f.journal).size, 'Nothing is replayed or re-numbered.');
  // The human checks and sends something; the CLI's next events set the real state.
  fs.appendFileSync(f.journal, JSON.stringify({ time: new Date().toISOString(), sessionId: 'session', runId: 'run', provider: 'claude', event: { session_id: 'native', cwd: f.project, prompt_id: 'turn-2', hook_event_name: 'UserPromptSubmit', prompt: 'Next' } }) + '\n');
  svc.refresh();
  assert.equal(f.session().status, 'running');
  assert.equal(f.session().error, null);
  svc.recoverCwdIncidents();
  assert.equal(f.store.all("SELECT 1 FROM audit WHERE action = 'cwd_incident_cleared'").length, 1, 'Running again on the next start changes nothing.');
});

test('startup recovery leaves Codex incidents and first-event incidents alone, and does not replay over later events', t => {
  const codex = legacyRun(t, 'codex', () => [{ hook_event_name: 'SessionStart' }, { hook_event_name: 'UserPromptSubmit', prompt: 'Task' }, { hook_event_name: 'Stop', cwd: os.tmpdir() }], [0, 1], 2);
  service(codex.store, { home: codex.home }).recoverCwdIncidents();
  assert.equal(codex.store.runRecord('run').attention, 'HOOK_PROJECT_MISMATCH', 'Codex keeps one cwd per session.');
  const first = legacyRun(t, 'claude', () => [{ hook_event_name: 'SessionStart', cwd: os.tmpdir() }, { hook_event_name: 'UserPromptSubmit', prompt: 'Task' }], [1], 0);
  service(first.store, { home: first.home }).recoverCwdIncidents();
  assert.equal(first.store.runRecord('run').attention, 'HOOK_PROJECT_MISMATCH', 'A foreign first event stays an incident even if a later one matched.');
  const none = legacyRun(t, 'claude', () => [{ hook_event_name: 'SessionStart', cwd: os.tmpdir() }], [], 0);
  service(none.store, { home: none.home }).recoverCwdIncidents();
  assert.equal(none.store.runRecord('run').attention, 'HOOK_PROJECT_MISMATCH', 'Nothing accepted before the incident: not a legacy cd.');
});

// Legacy releases still accepted events whose cwd was back at the root, then overwrote the status with the incident.
test('recovery reports ready only for a provably idle CLI and otherwise asks the human to check', t => {
  const sub = project => path.join(project, 'episodes', 'one');
  const cases = [
    ['finished at the root', project => [{ hook_event_name: 'PostToolUse', cwd: sub(project) }, { hook_event_name: 'Stop', last_assistant_message: 'Done' }, { hook_event_name: 'Notification', notification_type: 'idle_prompt' }], [3, 4], 'ready', null],
    ['permission waiting', project => [{ hook_event_name: 'PostToolUse', cwd: sub(project) }, { hook_event_name: 'PermissionRequest', tool_name: 'Bash' }, { hook_event_name: 'Notification', notification_type: 'permission_prompt' }], [3, 4], 'attention', 'TURN_STATE_UNKNOWN'],
    ['usage limit', project => [{ hook_event_name: 'PostToolUse', cwd: sub(project) }, { hook_event_name: 'StopFailure', error: 'rate_limit' }], [3], 'attention', 'TURN_STATE_UNKNOWN'],
    ['finished, then dropped work', project => [{ hook_event_name: 'PostToolUse', cwd: sub(project) }, { hook_event_name: 'Stop', last_assistant_message: 'Done' }, { hook_event_name: 'UserPromptSubmit', prompt: 'More', prompt_id: 'turn-2', cwd: sub(project) }], [3], 'attention', 'TURN_STATE_UNKNOWN'],
  ];
  for (const [name, tail, accepted, status, error] of cases) {
    const f = legacyRun(t, 'claude', project => [{ hook_event_name: 'SessionStart' }, { hook_event_name: 'UserPromptSubmit', prompt: 'Task' }, ...tail(project)], [0, 1, ...accepted], 2);
    const svc = service(f.store, { home: f.home });
    svc.recoverCwdIncidents();
    assert.equal(f.store.runRecord('run').attention, null, name);
    assert.equal(f.session().status, status, name);
    assert.equal(f.session().error, error, name);
  }
});

test('a legacy cd incident that cascaded into a turn mismatch is cleared once and shown as unconfirmed', t => {
  const sub = project => path.join(project, 'episodes', 'one');
  // Stop A and the human's prompt B ran in the subfolder and were dropped; B's tools and Stop came back to the root.
  const f = legacyRun(t, 'claude', project => [{ hook_event_name: 'SessionStart' }, { hook_event_name: 'UserPromptSubmit', prompt: 'Task' }, { hook_event_name: 'PostToolUse', cwd: sub(project) },
    { hook_event_name: 'Stop', last_assistant_message: 'Answer A', cwd: sub(project) }, { hook_event_name: 'UserPromptSubmit', prompt: 'Human B', prompt_id: 'turn-b', cwd: sub(project) },
    { hook_event_name: 'PostToolUse', prompt_id: 'turn-b' }, { hook_event_name: 'Stop', last_assistant_message: 'Answer B', prompt_id: 'turn-b' }], [0, 1, 5, 6], 2, 'HOOK_TURN_ID_MISMATCH');
  assert.equal(f.store.runRecord('run').attention, 'HOOK_TURN_ID_MISMATCH');
  const svc = service(f.store, { home: f.home });
  svc.recoverCwdIncidents();
  assert.equal(f.store.runRecord('run').attention, null);
  assert.equal(f.session().error, 'TURN_STATE_UNKNOWN');
  f.store.run("UPDATE runs SET attention = 'HOOK_TURN_ID_MISMATCH' WHERE id = 'run'");
  svc.recoverCwdIncidents();
  assert.equal(f.store.runRecord('run').attention, 'HOOK_TURN_ID_MISMATCH', 'Once per run: a later incident is a real one.');
});

test('Claude launches register the failure and denial hooks; Codex never receives them', async () => {
  const { launchCommand } = await import('../../broker/providers.mjs');
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'harbor-hooks-'));
  try {
    const config = { home, env: process.env, executables: { claude: fake, codex: fake } };
    launchCommand({ provider: 'claude', project: home, cli_args: '[]', native_id: randomUUID() }, config, 'Task');
    const events = Object.keys(JSON.parse(fs.readFileSync(path.join(home, 'claude-hooks.json'), 'utf8')).hooks);
    for (const name of ['PostToolUseFailure', 'PermissionDenied', 'PermissionRequest', 'Notification', 'StopFailure']) assert.ok(events.includes(name), name);
    const codex = launchCommand({ provider: 'codex', project: home, cli_args: '[]' }, config, 'Task').args.join(' ');
    assert.ok(!codex.includes('PostToolUseFailure') && !codex.includes('PermissionDenied'));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

const fake = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
let tmux = process.env.HARBOR_TEST_TMUX;
try { tmux ||= executable('tmux', { env: process.env, executables: {}, home: os.tmpdir() }); } catch {}
test('end to end: subdirectory cd and an auto-answered permission complete without attention', { skip: !tmux, timeout: 40000 }, async () => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'harbor-attention-e2e-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ executables: { tmux, claude: fake, codex: fake } }));
  const project = path.join(home, 'project'); fs.mkdirSync(project);
  const config = configuration({ ...process.env, HARBOR_HOME: home });
  const call = (action, args = {}) => rpc(action, args, { config });
  try {
    // AUTO_ALLOWED keeps the permission open for 1.5 s, so a wait polling every 200 ms would see any false attention.
    for (const [provider, text, outcome, response] of [['claude', 'CD_SUBDIR', 'completed', 'done in sub'], ['codex', 'AUTO_ALLOWED', 'completed', 'allowed'], ['claude', 'AUTO_ALLOWED', 'completed', 'allowed'], ['claude', 'CRON', 'completed', 'scheduled'], ['claude', 'FAIL_OVERLOADED', 'failed', null]]) {
      const id = randomUUID();
      await call('create', { id, provider, project, title: text, owner: 'grok', text, requestId: 'r1' });
      const done = await call('wait', { id, requestId: 'r1', timeout: 10000 });
      assert.equal(done.outcome, outcome, `${provider} ${text}: ${JSON.stringify(done.session)}`);
      assert.equal(done.request.response, response);
      assert.equal(done.session.status, 'ready', `${provider} ${text}`);
    }
    // A turn the human ends with Esc fires no hook; their next prompt closes the bot's request.
    const id = randomUUID();
    await call('create', { id, provider: 'claude', project, title: 'Esc', owner: 'grok', text: 'NEVER_STOPS', requestId: 'esc-1' });
    for (let attempt = 0; attempt < 50 && (await call('result', { id, requestId: 'esc-1' })).request.status !== 'running'; attempt++) await delay(100);
    const runId = (await call('result', { id })).session.runId;
    execFileSync(tmux, ['-S', config.tmuxSocket, 'send-keys', '-t', 'harbor-' + runId, '-l', 'Human follow-up']);
    execFileSync(tmux, ['-S', config.tmuxSocket, 'send-keys', '-t', 'harbor-' + runId, 'Enter']);
    const superseded = await call('wait', { id, requestId: 'esc-1', timeout: 10000 });
    assert.equal(superseded.outcome, 'interrupted');
    assert.equal(superseded.request.error, 'TURN_SUPERSEDED');
  } finally {
    try { process.kill(JSON.parse(fs.readFileSync(path.join(home, 'daemon.lock/owner.json'))).pid, 'SIGTERM'); } catch {}
    try { execFileSync(tmux, ['-S', config.tmuxSocket, 'kill-server'], { stdio: 'ignore' }); } catch {}
    await delay(100);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a Codex worktree launched from a repository subfolder is learned at the same position in the new checkout', t => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'harbor-subtree-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'repo'), project = path.join(repo, 'api'), tree = path.join(home, 'tree');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true }); fs.writeFileSync(path.join(project, 'src', 'keep'), '');
  const git = args => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']); git(['worktree', 'add', '-q', '--detach', tree]);
  const check = cwd => {
    const store = new Store(path.join(home, randomUUID() + '.sqlite'));
    try {
      store.run('INSERT INTO sessions(id,title,provider,project,cli_args,owner,status,run_id,pending,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', 'session', 'Sub', 'codex', project, '["--worktree"]', 'grok', 'starting', 'run', 1, 'now', 'now');
      store.run('INSERT INTO runs(id,session_id,tmux_name,started_at) VALUES(?,?,?,?)', 'run', 'session', 'harbor-run', 'now');
      acceptEvent(store, store.runRecord('run'), { sessionId: 'session', runId: 'run', provider: 'codex', event: { hook_event_name: 'SessionStart', session_id: 'native', cwd } }, 0);
      return store.session('session').working_directory;
    } finally { store.close(); }
  };
  assert.equal(check(path.join(tree, 'api')), fs.realpathSync(path.join(tree, 'api')));
  assert.equal(check(tree), fs.realpathSync(tree), 'The checkout root is accepted too.');
  assert.equal(check(path.join(tree, 'api', 'src')), null, 'A different position inside the checkout is not the worktree.');
  assert.equal(check(path.join(project, 'src')), null, 'A folder inside the project is not a worktree.');
});

test('after an unconfirmed recovery the CLI\'s next turn is adopted and the lost request ends as not observed', t => {
  const sub = project => path.join(project, 'episodes', 'one');
  const next = (f, event) => { fs.appendFileSync(f.journal, JSON.stringify({ time: new Date().toISOString(), sessionId: 'session', runId: 'run', provider: 'claude', event: { session_id: 'native', cwd: f.project, ...event } }) + '\n'); };
  // Turn A's Stop and the human's prompt B were dropped in the subfolder; B is still running when Harbor updates.
  const running = legacyRun(t, 'claude', project => [{ hook_event_name: 'SessionStart' }, { hook_event_name: 'UserPromptSubmit', prompt: 'Task' }, { hook_event_name: 'PostToolUse', cwd: sub(project) },
    { hook_event_name: 'Stop', last_assistant_message: 'Answer A', cwd: sub(project) }, { hook_event_name: 'UserPromptSubmit', prompt: 'Human B', prompt_id: 'turn-b', cwd: sub(project) }], [0, 1], 2);
  const svc = service(running.store, { home: running.home });
  svc.recoverCwdIncidents();
  assert.equal(running.session().error, 'TURN_STATE_UNKNOWN');
  assert.equal(running.receipt('request').error, 'RESULT_NOT_OBSERVED');
  next(running, { hook_event_name: 'PostToolUse', prompt_id: 'turn-b' });
  svc.refresh();
  assert.equal(running.session().status, 'running', 'The CLI\'s next tool event names the turn again.');
  assert.equal(running.session().active_turn, 'turn-b');
  next(running, { hook_event_name: 'Stop', prompt_id: 'turn-b', last_assistant_message: 'Answer B' });
  svc.refresh();
  assert.equal(running.store.runRecord('run').attention, null, 'No new turn mismatch.');
  assert.equal(running.session().status, 'ready');
  assert.equal(running.receipt('request').status, 'interrupted');
  assert.equal(running.receipt('request').error, 'RESULT_NOT_OBSERVED', 'Never reported as a human interruption.');
  // The CLI finished in the subfolder and is idle: the human's next prompt moves it on.
  const idle = legacyRun(t, 'claude', project => [{ hook_event_name: 'SessionStart' }, { hook_event_name: 'UserPromptSubmit', prompt: 'Task' }, { hook_event_name: 'PostToolUse', cwd: sub(project) },
    { hook_event_name: 'Stop', last_assistant_message: 'Answer A', cwd: sub(project) }], [0, 1], 2);
  const idleSvc = service(idle.store, { home: idle.home });
  idleSvc.recoverCwdIncidents();
  next(idle, { hook_event_name: 'UserPromptSubmit', prompt_id: 'turn-c', prompt: 'Human C' });
  next(idle, { hook_event_name: 'Stop', prompt_id: 'turn-c', last_assistant_message: 'Answer C' });
  idleSvc.refresh();
  assert.equal(idle.session().status, 'ready');
  assert.equal(idle.receipt('request').error, 'RESULT_NOT_OBSERVED');
  assert.equal(idle.receipt('request').status, 'interrupted');
});

test('the unknown-turn marker survives permission dialogs and compaction, and a later continuation reopens the turn', t => {
  const sub = project => path.join(project, 'episodes', 'one');
  const next = (f, event) => { fs.appendFileSync(f.journal, JSON.stringify({ time: new Date().toISOString(), sessionId: 'session', runId: 'run', provider: 'claude', event: { session_id: 'native', cwd: f.project, ...event } }) + '\n'); };
  const f = legacyRun(t, 'claude', project => [{ hook_event_name: 'SessionStart' }, { hook_event_name: 'UserPromptSubmit', prompt: 'Task' }, { hook_event_name: 'PostToolUse', cwd: sub(project) },
    { hook_event_name: 'UserPromptSubmit', prompt: 'Human B', prompt_id: 'turn-b', cwd: sub(project) }], [0, 1], 2);
  const svc = service(f.store, { home: f.home });
  svc.recoverCwdIncidents();
  next(f, { hook_event_name: 'SessionStart', source: 'compact' });
  svc.refresh();
  assert.equal(f.session().error, 'TURN_STATE_UNKNOWN', 'Compaction mid-turn is not idleness.');
  next(f, { hook_event_name: 'PermissionRequest', prompt_id: 'turn-b' });
  next(f, { hook_event_name: 'Notification', notification_type: 'permission_prompt', prompt_id: 'turn-b' });
  svc.refresh();
  assert.equal(f.session().error, 'PERMISSION_REQUIRED');
  assert.equal(f.session().active_turn, 'turn-b', 'The dialog names the running turn.');
  next(f, { hook_event_name: 'PostToolUse', prompt_id: 'turn-b' });
  svc.refresh();
  assert.equal(f.session().status, 'running', 'Approving clears the dialog as in a normal run.');
  next(f, { hook_event_name: 'Stop', prompt_id: 'turn-b', last_assistant_message: 'Interim' });
  next(f, { hook_event_name: 'PostToolUse', prompt_id: 'turn-b' });
  svc.refresh();
  assert.equal(f.session().pending, 1, 'A Stop-hook continuation of the same prompt reopens the turn.');
  // An accepted request loses an earlier delivery error, so a later supersede is reported as such.
  const g = fixture(t);
  g.emit('SessionStart');
  g.store.run("UPDATE requests SET status = 'uncertain', error = 'DAEMON_RESTARTED_DURING_DELIVERY' WHERE request_id = 'request'");
  g.emit('UserPromptSubmit', { prompt: 'Task' });
  assert.equal(g.receipt('request').error, null);
  g.setTurn('turn-2'); g.emit('UserPromptSubmit', { prompt: 'Human' });
  assert.equal(g.receipt('request').error, 'TURN_SUPERSEDED');
});
