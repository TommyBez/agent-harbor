import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { rpc } from '../../broker/client.mjs';
import { Store } from '../../broker/store.mjs';
import { Service } from '../../broker/service.mjs';
import { configuration, executable } from '../../broker/common.mjs';
import { trustPrompt, autoTrustRoot, parentSuggestion, trustedFolders, updateTrustedFolders, UPDATE_NOTICE, WORKTREE_TRUST_ERROR } from '../../broker/trust.mjs';

// Screens captured from Claude Code 2.1.302 and Codex 0.162.1 (folder redacted).
const CLAUDE_SCREEN = `────────────────────────────────────────
 Accessing workspace:

 /Users/example/projects/arrow drift

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from
 your team). If not, take a moment to review what's in this folder first.
 Claude Code'll be able to read, edit, and execute files here.
 Security guide
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel`;
const CODEX_SCREEN = `  Folder access
  /Users/example/projects/arrow drift
  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings can run code
  automatically, even without a model request. Continue only if you trust these files. Your trust decision will be saved.
› 1. Trust and continue
  2. Back to Agent Command Center
  enter continue · esc back`;
const HOOKS_SCREEN = `  Hooks need review         

  7 hooks are new or changed.                

  Hooks can run outside the sandbox after you trust them.

› 1. Review hooks                                                                                                                           
  2. Trust all and continue
  3. Continue without trusting (hooks won't run)

  enter confirm · esc skip`;
const UPDATE_SCREEN = `  Update available · 0.162.1 → 0.163.0
  Release notes: https://github.com/openai/codex/releases/latest
› 1. Update now (runs \`sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh'\`)
  2. Skip
  3. Skip until next version
  enter continue · esc skip`;

test('trust dialogs are recognized only in their exact provider form, with the folder and highlighted choice', () => {
  assert.deepEqual(trustPrompt('claude', CLAUDE_SCREEN), { kind: 'folder', folder: '/Users/example/projects/arrow drift', selected: 'other', navigate: true });
  assert.deepEqual(trustPrompt('claude', CLAUDE_SCREEN.replace(' ❯ No, exit\n   Yes', '   No, exit\n ❯ Yes')), { kind: 'folder', folder: '/Users/example/projects/arrow drift', selected: 'accept', navigate: true });
  assert.deepEqual(trustPrompt('codex', CODEX_SCREEN), { kind: 'folder', folder: '/Users/example/projects/arrow drift', selected: 'accept', navigate: false });
  assert.deepEqual(trustPrompt('codex', HOOKS_SCREEN), { kind: 'hooks', folder: null, selected: 'other', navigate: true });
  assert.deepEqual(trustPrompt('codex', HOOKS_SCREEN.replace('› 1. Review hooks', '  1. Review hooks').replace('  2. Trust all', '› 2. Trust all')).selected, 'accept');
  assert.equal(trustPrompt('codex', CODEX_SCREEN + '\n' + CODEX_SCREEN.replace('› 1. Trust', '  1. Trust')).selected, 'other', 'Only the newest rendering counts.');
  assert.equal(trustPrompt('codex', CLAUDE_SCREEN), null);
  assert.equal(trustPrompt('claude', CODEX_SCREEN), null);
  assert.equal(trustPrompt('codex', UPDATE_SCREEN), null);
  assert.equal(trustPrompt('codex', '› Write tests for @filename\n  gpt-5 · 100% left'), null);
  assert.match(UPDATE_SCREEN, UPDATE_NOTICE);
  assert.doesNotMatch(CODEX_SCREEN, UPDATE_NOTICE);
  assert.match('Error creating worktree: Workspace trust not yet accepted. Run `claude` once in this directory', WORKTREE_TRUST_ERROR);
});

test('pre-authorized folders are human-chosen, never too broad, and cover only folders inside them', () => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'harbor-trust-unit-'));
  try {
    const config = { home };
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ executables: { tmux: '/bin/echo' } }));
    const games = path.join(home, 'games'), project = path.join(games, 'arrow'), outside = path.join(home, 'outside');
    fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(games, 'escape'));
    assert.throws(() => updateTrustedFolders(config, { add: 'games' }), { code: 'INVALID_TRUSTED_FOLDER' });
    assert.throws(() => updateTrustedFolders(config, { add: path.join(home, 'missing') }), { code: 'INVALID_TRUSTED_FOLDER' });
    assert.throws(() => updateTrustedFolders(config, { add: '/' }), { code: 'TRUSTED_FOLDER_TOO_BROAD' });
    assert.throws(() => updateTrustedFolders(config, { add: os.homedir() }), { code: 'TRUSTED_FOLDER_TOO_BROAD' });
    assert.deepEqual(updateTrustedFolders(config, { add: games }), [games]);
    assert.deepEqual(updateTrustedFolders(config, { add: games + '/' }), [games], 'Duplicates collapse.');
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.deepEqual(saved.executables, { tmux: '/bin/echo' }, 'Other settings are preserved.');
    assert.equal(fs.statSync(path.join(home, 'config.json')).mode & 0o777, 0o600);
    assert.equal(autoTrustRoot(config, project, project), games);
    assert.equal(autoTrustRoot(config, games, project), games, 'A dialog for a parent folder of the launch still qualifies.');
    assert.equal(autoTrustRoot(config, project, outside), null, 'The dialog must concern the launch directory.');
    assert.equal(autoTrustRoot(config, path.join(games, 'escape'), path.join(games, 'escape')), null, 'Symbolic links cannot escape the trusted folder.');
    assert.equal(autoTrustRoot(config, null, project), null, 'An unreadable folder is never trusted automatically.');
    assert.equal(parentSuggestion(project), games);
    assert.equal(parentSuggestion(path.join(os.homedir(), 'project')), null);
    assert.deepEqual(updateTrustedFolders(config, { remove: games }), []);
    assert.deepEqual(trustedFolders(config), []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

const fake = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
let tmux = process.env.HARBOR_TEST_TMUX;
try { tmux ||= executable('tmux', { env: process.env, executables: {}, home: os.tmpdir() }); } catch {}
const supported = !!tmux && fs.existsSync(tmux);
async function environment(markers = []) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'harbor-trust-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ executables: { tmux, claude: fake, codex: fake } }));
  const project = path.join(home, 'projects', 'game'); fs.mkdirSync(project, { recursive: true });
  for (const name of ['.fake-untrusted', ...markers]) fs.writeFileSync(path.join(project, name), '');
  const config = configuration({ ...process.env, HARBOR_HOME: home });
  const call = (action, args = {}) => rpc(action, args, { config });
  const audit = () => { const db = path.join(home, 'harbor.sqlite'); return execFileSync('sqlite3', [db, 'SELECT action FROM audit ORDER BY seq'], { encoding: 'utf8' }).split('\n').filter(Boolean); };
  const cleanup = async () => {
    try { const pid = JSON.parse(fs.readFileSync(path.join(home, 'daemon.lock/owner.json'))).pid; process.kill(pid, 'SIGTERM'); } catch {}
    try { execFileSync(tmux, ['-S', config.tmuxSocket, 'kill-server'], { stdio: 'ignore' }); } catch {}
    await delay(100);
    fs.rmSync(home, { recursive: true, force: true });
  };
  return { home, project, config, call, audit, cleanup, projects: path.join(home, 'projects') };
}

for (const provider of ['claude', 'codex']) test(`${provider}: an untrusted folder asks the human in Harbor; the bot cannot answer and keeps its control`, { skip: !supported, timeout: 30000 }, async () => {
  const env = await environment(); const { call, project } = env;
  try {
    const id = randomUUID();
    await call('create', { id, provider, project, title: 'Trust', owner: 'grok', text: 'MARKER:one', requestId: 'first' });
    const waiting = await call('wait', { id, requestId: 'first', timeout: 10000 });
    assert.equal(waiting.outcome, 'attention');
    assert.equal(waiting.session.error, 'TRUST_REQUIRED');
    assert.equal(waiting.session.trustFolder, project);
    assert.equal(waiting.session.trustParent, env.projects);
    assert.equal(waiting.request.status, 'awaiting_ack');
    await assert.rejects(call('trust', { id, actor: 'grok' }), { code: 'TRUST_HUMAN_ONLY' });
    await assert.rejects(call('trusted-folders', { add: env.projects, actor: 'grok' }), { code: 'TRUST_HUMAN_ONLY' });
    const blocked = await call('wait', { id, requestId: 'first', timeout: 300, throughAttention: true });
    assert.equal(blocked.outcome, 'timeout', 'A bot can wait through attention without polling.');
    await call('trust', { id, actor: 'human' });
    const done = await call('wait', { id, requestId: 'first', timeout: 10000, throughAttention: true });
    assert.equal(done.outcome, 'completed');
    assert.equal(done.request.response, 'ANSWER:MARKER:one');
    assert.equal(done.session.owner, 'grok', 'Approving trust does not take control.');
    assert.equal(done.session.trustFolder, null);
    await assert.rejects(call('trust', { id, actor: 'human' }), { code: 'TRUST_PROMPT_ABSENT' });
    assert.ok(env.audit().includes('trust_approved'));
    assert.deepEqual((await call('trusted-folders')).folders, []);
  } finally { await env.cleanup(); }
});

test('Codex in a pre-authorized folder skips the update notice, trusts folder and hooks, and starts without the human', { skip: !supported, timeout: 30000 }, async () => {
  const env = await environment(['.fake-update', '.fake-hooks']); const { call, project } = env;
  try {
    await call('trusted-folders', { add: env.projects });
    const id = randomUUID();
    await call('create', { id, provider: 'codex', project, title: 'Codex trust', owner: 'grok', text: 'MARKER:codex', requestId: 'codex-1' });
    const done = await call('wait', { id, requestId: 'codex-1', timeout: 15000 });
    assert.equal(done.outcome, 'completed', JSON.stringify(done.session));
    assert.equal(done.request.response, 'ANSWER:MARKER:codex');
    assert.equal(fs.existsSync(path.join(project, '.fake-updated')), false, 'Harbor never chooses Update now.');
    assert.ok(fs.existsSync(path.join(project, '.fake-hooks-trusted')));
    const actions = env.audit();
    assert.ok(actions.includes('update_notice_skipped'));
    assert.equal(actions.filter(action => action === 'trust_auto_accepted').length, 2, 'Folder and hook trust.');
  } finally { await env.cleanup(); }
});

test('Codex hook review outside a pre-authorized folder waits for one human click', { skip: !supported, timeout: 30000 }, async () => {
  const env = await environment(['.fake-trusted', '.fake-hooks']); const { call, project } = env;
  try {
    const id = randomUUID();
    await call('create', { id, provider: 'codex', project, title: 'Hooks', owner: 'grok', text: 'MARKER:hooks', requestId: 'hooks-1' });
    const waiting = await call('wait', { id, requestId: 'hooks-1', timeout: 10000 });
    assert.equal(waiting.session.error, 'HOOK_TRUST_REQUIRED');
    assert.equal(waiting.session.trustFolder, project);
    await assert.rejects(call('trust', { id, actor: 'grok' }), { code: 'TRUST_HUMAN_ONLY' });
    await call('trust', { id, actor: 'human' });
    const done = await call('wait', { id, requestId: 'hooks-1', timeout: 10000 });
    assert.equal(done.outcome, 'completed', JSON.stringify(done.session));
    assert.ok(fs.existsSync(path.join(project, '.fake-hooks-trusted')));
  } finally { await env.cleanup(); }
});

test('Claude in a pre-authorized folder selects and confirms trust itself', { skip: !supported, timeout: 30000 }, async () => {
  const env = await environment(); const { call, project } = env;
  try {
    await call('trusted-folders', { add: env.projects });
    const id = randomUUID();
    await call('create', { id, provider: 'claude', project, title: 'Claude trust', owner: 'grok', text: 'MARKER:claude', requestId: 'claude-1' });
    const done = await call('wait', { id, requestId: 'claude-1', timeout: 15000 });
    assert.equal(done.outcome, 'completed', JSON.stringify(done.session));
    assert.ok(env.audit().includes('trust_auto_accepted'));
  } finally { await env.cleanup(); }
});

test('a Claude worktree launch shows the trust dialog in a helper, then repeats the same launch and request', { skip: !supported, timeout: 40000 }, async () => {
  const env = await environment(); const { call, project } = env;
  try {
    const id = randomUUID();
    const created = await call('create', { id, provider: 'claude', project, title: 'Worktree', owner: 'grok', cliArgs: ['--worktree', 'fluid'], text: 'MARKER:tree', requestId: 'tree-1' });
    const firstRun = created.session.runId;
    const waiting = await call('wait', { id, requestId: 'tree-1', timeout: 10000 });
    assert.equal(waiting.outcome, 'attention', JSON.stringify(waiting.session));
    assert.equal(waiting.session.error, 'TRUST_REQUIRED');
    assert.notEqual(waiting.session.runId, firstRun);
    assert.ok(waiting.session.terminal.args.includes('attach-session') && !waiting.session.terminal.args.includes('read-only,ignore-size'), 'The helper terminal stays writable for the human.');
    await call('trust', { id, actor: 'human', folder: env.projects });
    const done = await call('wait', { id, requestId: 'tree-1', timeout: 15000 });
    assert.equal(done.outcome, 'completed', JSON.stringify(done.session));
    assert.equal(done.request.response, 'ANSWER:MARKER:tree');
    assert.notEqual(done.request.runId, firstRun);
    assert.ok(done.session.cliArgs.includes('--worktree'));
    assert.deepEqual((await call('trusted-folders')).folders, [env.projects]);
    const actions = env.audit();
    for (const action of ['trust_helper_started', 'trust_approved', 'trusted_folders_changed', 'trust_relaunch']) assert.ok(actions.includes(action), action);
    assert.equal(fs.readdirSync(path.join(env.home, 'runs')).some(run => fs.existsSync(path.join(env.home, 'runs', run, 'launch.json'))), false, 'The private launch copy is removed.');
  } finally { await env.cleanup(); }
});

test('a pre-authorized worktree launch needs nobody', { skip: !supported, timeout: 40000 }, async () => {
  const env = await environment(); const { call, project } = env;
  try {
    await call('trusted-folders', { add: env.projects });
    const id = randomUUID();
    await call('create', { id, provider: 'claude', project, title: 'Worktree auto', owner: 'grok', cliArgs: ['--worktree'], text: 'MARKER:auto', requestId: 'auto-1' });
    const done = await call('wait', { id, requestId: 'auto-1', timeout: 20000 });
    assert.equal(done.outcome, 'completed', JSON.stringify(done.session));
    assert.equal(done.request.response, 'ANSWER:MARKER:auto');
  } finally { await env.cleanup(); }
});

test('uppercase session IDs from uuidgen are observed, including through the trust helper', { skip: !supported, timeout: 40000 }, async () => {
  const env = await environment(); const { call, project } = env;
  try {
    await call('trusted-folders', { add: env.projects });
    const id = randomUUID().toUpperCase();
    await call('create', { id, provider: 'claude', project, title: 'Upper', owner: 'grok', cliArgs: ['--worktree', 'fluid'], text: 'MARKER:upper', requestId: 'up-1' });
    const done = await call('wait', { id, requestId: 'up-1', timeout: 20000 });
    assert.equal(done.outcome, 'completed', JSON.stringify(done.session));
    assert.equal(done.session.id, id);
    // The real observer, not the fake CLI's own journal writer, must accept the uppercase identity.
    const runId = randomUUID();
    fs.mkdirSync(path.join(env.home, 'runs', runId));
    execFileSync(process.execPath, [fileURLToPath(new URL('../../broker/hooks/observe.mjs', import.meta.url)), 'claude'], { input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'x' }), env: { ...process.env, HARBOR_HOME: env.home, HARBOR_SESSION_ID: id, HARBOR_RUN_ID: runId } });
    const line = JSON.parse(fs.readFileSync(path.join(env.home, 'runs', runId, 'events.jsonl'), 'utf8'));
    assert.equal(line.sessionId, id);
  } finally { await env.cleanup(); }
});

test('the trust helper continues when the dialog closes even if hooks never report', { skip: !supported, timeout: 40000 }, async () => {
  const env = await environment(['.fake-helper-no-hooks']); const { call, project } = env;
  try {
    const id = randomUUID();
    await call('create', { id, provider: 'claude', project, title: 'Silent helper', owner: 'grok', cliArgs: ['--worktree'], text: 'MARKER:silent', requestId: 'silent-1' });
    const waiting = await call('wait', { id, requestId: 'silent-1', timeout: 10000 });
    assert.equal(waiting.session.error, 'TRUST_REQUIRED');
    await call('trust', { id, actor: 'human' });
    const done = await call('wait', { id, requestId: 'silent-1', timeout: 20000, throughAttention: true });
    assert.equal(done.outcome, 'completed', JSON.stringify(done.session));
    assert.ok(env.audit().includes('trust_helper_dialog_closed'));
  } finally { await env.cleanup(); }
});

test('declining trust leaves no conversation and the session can start again', { skip: !supported, timeout: 30000 }, async () => {
  const env = await environment(); const { call, project } = env;
  try {
    const id = randomUUID();
    await call('create', { id, provider: 'claude', project, title: 'Decline', owner: 'grok', text: 'MARKER:no', requestId: 'no-1' });
    const waiting = await call('wait', { id, requestId: 'no-1', timeout: 10000 });
    assert.equal(waiting.session.error, 'TRUST_REQUIRED');
    // The human chooses the highlighted "No, exit" in the CLI's own dialog.
    execFileSync(tmux, ['-S', env.config.tmuxSocket, 'send-keys', '-t', 'harbor-' + waiting.session.runId, 'Enter']);
    const declined = await call('wait', { id, requestId: 'no-1', timeout: 10000 });
    assert.equal(declined.outcome, 'interrupted');
    assert.equal(declined.request.error, 'TRUST_DECLINED');
    assert.equal(declined.session.status, 'stopped');
    assert.equal(declined.session.error, 'TRUST_DECLINED');
    assert.equal(declined.session.nativeSessionId, null);
    await assert.rejects(call('resume', { id, actor: 'grok', text: 'again', requestId: 'no-2' }), { code: 'SESSION_NOT_STARTED' });
    fs.writeFileSync(path.join(project, '.fake-trusted'), '');
    await call('start', { id, actor: 'grok', text: 'MARKER:yes', requestId: 'no-2' });
    const done = await call('wait', { id, requestId: 'no-2', timeout: 10000 });
    assert.equal(done.outcome, 'completed');
  } finally { await env.cleanup(); }
});

for (const blocked of [true, false]) test(`a session whose only launch ${blocked ? 'died at Claude\'s worktree trust check starts again from scratch' : 'died for another reason still refuses recovery'}`, async () => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'harbor-unstarted-'));
  try {
    const project = path.join(home, 'project'); fs.mkdirSync(project);
    const config = { home, env: process.env, executables: { claude: fake }, startupTimeout: 30000, stopTimeout: 20000 };
    const store = new Store(path.join(home, 'harbor.sqlite'));
    const id = randomUUID(), runId = randomUUID(), oldNative = randomUUID();
    store.run("INSERT INTO sessions(id,title,provider,project,cli_args,owner,status,native_id,run_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", id, 'Fluidity', 'claude', project, '["--worktree","fluid"]', 'grok', 'stopped', oldNative, runId, 'now', 'now');
    store.run("INSERT INTO runs(id,session_id,tmux_name,started_at,ended_at) VALUES(?,?,?,?,?)", runId, id, 'harbor-' + runId, 'now', 'now');
    store.run("INSERT INTO requests(session_id,request_id,run_id,prompt_hash,payload_hash,status,actor,created_at,transport,error) VALUES(?,?,?,?,?,?,?,?,?,?)", id, 'first', runId, 'x', 'x', 'interrupted', 'grok', 'now', 'cli-initial-prompt', 'PROCESS_EXITED');
    fs.mkdirSync(path.join(home, 'runs', runId), { recursive: true });
    fs.writeFileSync(path.join(home, 'runs', runId, 'final-screen.txt'), blocked ? 'Error creating worktree: Workspace trust not yet accepted. Run `claude` once in this directory' : 'Segmentation fault');
    const launched = [];
    const tmux = { binary: '/bin/echo', args: () => [], capture: () => '', screen: () => '', syncOwnership() {}, removeDeadSession: () => false,
      panes: () => new Map(launched.map(l => [l.paneId, { id: l.paneId, name: l.name, pid: 1, alive: true, windowIndex: 0, paneIndex: 0 }])),
      launch(run, session, command) { launched.push({ paneId: '%' + (launched.length + 1), name: run.tmux_name, command }); return { paneId: launched.at(-1).paneId, pid: 1 }; } };
    const service = new Service(config, store, tmux);
    const resume = () => service.start(store.session(id), { action: 'resume', text: 'Go', requestId: 'second' }, 'grok');
    if (!blocked) { await assert.rejects(resume(), { code: 'SESSION_ID_UNVERIFIED' }); return; }
    const response = await resume();
    const args = launched[0].command.args;
    assert.ok(args.includes('--session-id') && !args.includes('--resume'), 'A first launch, not a resume of a conversation that never existed.');
    assert.ok(args.includes('--worktree'));
    assert.notEqual(response.session.nativeSessionId, oldNative);
    assert.ok(fs.existsSync(path.join(home, 'runs', response.session.runId, 'launch.json')), 'The trust helper can repeat this launch.');
    assert.equal(store.get("SELECT action FROM audit ORDER BY seq DESC LIMIT 1").action, 'start_intent');
    store.close();
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
