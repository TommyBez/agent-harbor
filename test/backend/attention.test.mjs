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

test('acknowledgement age counts from this run\'s delivery, and a superseded uncertain delivery asks nothing', t => {
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
});

// Recreates what releases up to 0.1.3 left behind: a journal whose events after Claude's cd were dropped, the offset past them.
function legacyRun(t, provider, lines, accepted, incidentAt) {
  const f = fixture(t, provider);
  const journal = path.join(f.home, 'runs', 'run', 'events.jsonl');
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  const offsets = [], entries = []; let bytes = '';
  for (const event of lines(f.project)) {
    const entry = { time: new Date().toISOString(), sessionId: 'session', runId: 'run', provider, event: { session_id: 'native', cwd: f.project, [provider === 'codex' ? 'turn_id' : 'prompt_id']: 'turn', ...event } };
    offsets.push(Buffer.byteLength(bytes)); entries.push(entry); bytes += JSON.stringify(entry) + '\n';
  }
  fs.writeFileSync(journal, bytes);
  for (const index of accepted) acceptEvent(f.store, f.store.runRecord('run'), entries[index], offsets[index]);
  f.store.run("UPDATE runs SET offset = ?, attention = 'HOOK_PROJECT_MISMATCH', hooks_ready = 1 WHERE id = 'run'", Buffer.byteLength(bytes));
  f.store.run("UPDATE sessions SET status = 'attention', error = 'HOOK_PROJECT_MISMATCH' WHERE id = 'session'");
  f.store.audit('HOOK_PROJECT_MISMATCH', 'session', { runId: 'run', offset: offsets[incidentAt] });
  return { ...f, journal };
}

test('a legacy cwd incident clears on startup and the dropped events, including the Stop, are imported again', t => {
  const f = legacyRun(t, 'claude', project => [{ hook_event_name: 'SessionStart' }, { hook_event_name: 'UserPromptSubmit', prompt: 'Task' },
    { hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: path.join(project, 'episodes', 'one') }, { hook_event_name: 'Stop', last_assistant_message: 'The real answer', cwd: path.join(project, 'episodes', 'one') }], [0, 1], 2);
  const svc = service(f.store, { home: f.home });
  svc.recoverCwdIncidents();
  assert.equal(f.store.runRecord('run').attention, null);
  svc.refresh();
  assert.equal(f.receipt('request').status, 'completed');
  assert.equal(f.receipt('request').response, 'The real answer');
  assert.equal(f.session().status, 'ready');
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
  const later = legacyRun(t, 'claude', () => [{ hook_event_name: 'SessionStart' }, { hook_event_name: 'UserPromptSubmit', prompt: 'Task' }, { hook_event_name: 'PostToolUse', cwd: os.tmpdir() }, { hook_event_name: 'Stop', last_assistant_message: 'Done' }], [0, 1, 3], 2);
  service(later.store, { home: later.home }).recoverCwdIncidents();
  assert.equal(later.store.runRecord('run').attention, null);
  assert.equal(later.store.runRecord('run').offset, fs.statSync(later.journal).size, 'No replay once later events were accepted.');
  assert.equal(later.session().status, 'ready');
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
