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
import { configuration, executable, hashPrompt } from '../../broker/common.mjs';
import { Store } from '../../broker/store.mjs';
import { acceptEvent } from '../../broker/events.mjs';

// The session's owner can steer a running turn and interrupt it, as typing and Esc do in the CLI's own terminal.
const fake = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
let tmux = process.env.HARBOR_TEST_TMUX;
try { tmux ||= executable('tmux', { env: process.env, executables: {}, home: os.tmpdir() }); } catch {}
async function environment(t) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'harbor-steer-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ executables: { tmux, claude: fake, codex: fake } }));
  const project = path.join(home, 'project'); fs.mkdirSync(project);
  const config = configuration({ ...process.env, HARBOR_HOME: home });
  const call = (action, args = {}) => rpc(action, args, { config });
  t.after(async () => {
    try { process.kill(JSON.parse(fs.readFileSync(path.join(home, 'daemon.lock/owner.json'))).pid, 'SIGTERM'); } catch {}
    try { execFileSync(tmux, ['-S', config.tmuxSocket, 'kill-server'], { stdio: 'ignore' }); } catch {}
    await delay(100);
    fs.rmSync(home, { recursive: true, force: true });
  });
  const running = async (id, requestId) => { for (let i = 0; i < 50; i++) { if ((await call('result', { id, requestId })).request.status === 'running') return; await delay(100); } throw new Error('never running'); };
  const start = async (provider, text, owner = 'grok') => { const id = randomUUID(); await call('create', { id, provider, project, title: text, owner, text, requestId: 'task' }); await running(id, 'task'); return id; };
  const typeInTerminal = async (id, text) => { const runId = (await call('result', { id })).session.runId; execFileSync(tmux, ['-S', config.tmuxSocket, 'send-keys', '-t', 'harbor-' + runId, '-l', text]); execFileSync(tmux, ['-S', config.tmuxSocket, 'send-keys', '-t', 'harbor-' + runId, 'Enter']); };
  const attention = async id => { const db = path.join(home, 'harbor.sqlite'); return execFileSync('sqlite3', [db, `SELECT COALESCE(r.attention,'') FROM sessions s JOIN runs r ON r.id = s.run_id WHERE s.id = '${id}'`], { encoding: 'utf8' }).trim(); };
  return { call, start, typeInTerminal, attention, project };
}

test('Codex: a steered message joins the running turn, and both requests get its final answer', { skip: !tmux, timeout: 30000 }, async t => {
  const { call, start } = await environment(t);
  const id = await start('codex', 'LONG');
  await call('send', { id, actor: 'grok', steer: true, text: 'also say BANANA', requestId: 'steer' });
  const steered = await call('wait', { id, requestId: 'steer', timeout: 10000 });
  assert.equal(steered.outcome, 'completed');
  assert.equal(steered.request.response, 'long done +also say BANANA');
  assert.equal((await call('result', { id, requestId: 'task' })).request.response, 'long done +also say BANANA');
  assert.equal(steered.session.status, 'ready');
});

test('Claude: a message steered before the next tool result is answered in the same turn', { skip: !tmux, timeout: 30000 }, async t => {
  const { call, start, attention } = await environment(t);
  const id = await start('claude', 'LONG_TOOL');
  await call('send', { id, actor: 'grok', steer: true, text: 'mention PINEAPPLE', requestId: 'steer' });
  const steered = await call('wait', { id, requestId: 'steer', timeout: 10000 });
  assert.equal(steered.request.response, 'long done +mention PINEAPPLE');
  assert.equal(await attention(id), '');
});

test('Claude: a message steered while it writes is answered in a continuation turn, without a false incident', { skip: !tmux, timeout: 30000 }, async t => {
  const { call, start, attention } = await environment(t);
  const id = await start('claude', 'LONG');
  await call('send', { id, actor: 'grok', steer: true, text: 'then say BANANA', requestId: 'steer' });
  const task = await call('wait', { id, requestId: 'task', timeout: 10000 });
  assert.equal(task.request.response, 'long done', 'The original request keeps its own answer.');
  const steered = await call('wait', { id, requestId: 'steer', timeout: 10000 });
  assert.equal(steered.outcome, 'completed');
  assert.equal(steered.request.response, 'continued: then say BANANA');
  assert.equal(await attention(id), '', 'The continuation turn is not a turn mismatch.');
  assert.equal(steered.session.status, 'ready');
});

test('Claude: a human typing mid-turn in the terminal no longer raises a turn mismatch', { skip: !tmux, timeout: 30000 }, async t => {
  const { call, start, typeInTerminal, attention } = await environment(t);
  const id = await start('claude', 'LONG', 'human');
  await typeInTerminal(id, 'and one more thing');
  await call('wait', { id, requestId: 'task', timeout: 10000 });
  for (let i = 0; i < 30 && (await call('result', { id })).session.pending; i++) await delay(100);
  assert.equal(await attention(id), '');
  assert.equal((await call('result', { id })).session.status, 'ready');
});

for (const provider of ['codex', 'claude']) test(`${provider}: the owner interrupts a running turn and can send the next task`, { skip: !tmux, timeout: 30000 }, async t => {
  const { call, start } = await environment(t);
  const id = await start(provider, 'LONG');
  await assert.rejects(call('interrupt', { id, actor: 'human' }), { code: 'CONTROL_DENIED' });
  const interrupted = await call('interrupt', { id, actor: 'grok' });
  assert.equal(interrupted.session.status, 'ready');
  assert.equal(interrupted.session.pending, false);
  const task = await call('result', { id, requestId: 'task' });
  assert.equal(task.request.status, 'interrupted');
  await call('send', { id, actor: 'grok', text: 'next', requestId: 'next' });
  assert.equal((await call('wait', { id, requestId: 'next', timeout: 10000 })).request.response, 'ANSWER:next');
  await assert.rejects(call('interrupt', { id, actor: 'grok' }), { code: 'NO_ACTIVE_TURN' });
});

test('steering and interrupting refuse to touch a waiting dialog, an idle CLI or someone else\'s session', { skip: !tmux, timeout: 40000 }, async t => {
  const { call, start } = await environment(t);
  const blocked = await start('codex', 'BLOCK');
  for (let i = 0; i < 100 && (await call('result', { id: blocked })).session.status !== 'attention'; i++) await delay(100);
  await assert.rejects(call('send', { id: blocked, actor: 'grok', steer: true, text: 'y', requestId: 's' }), { code: 'CLI_WAITING_FOR_HUMAN' });
  await assert.rejects(call('interrupt', { id: blocked, actor: 'grok' }), { code: 'CLI_WAITING_FOR_HUMAN' });
  const fresh = await start('claude', 'BLOCK');
  await assert.rejects(call('send', { id: fresh, actor: 'grok', steer: true, text: 'y', requestId: 's' }), { code: 'CLI_WAITING_FOR_HUMAN' }, 'A just-raised permission request may already have its dialog open.');
  const human = await start('claude', 'LONG', 'human');
  await assert.rejects(call('send', { id: human, actor: 'grok', steer: true, text: 'x', requestId: 's' }), { code: 'CONTROL_DENIED' });
  const done = await start('codex', 'LONG');
  await call('wait', { id: done, requestId: 'task', timeout: 10000 });
  await assert.rejects(call('send', { id: done, actor: 'grok', steer: true, text: 'x', requestId: 's' }), { code: 'NO_ACTIVE_TURN' });
  await assert.rejects(call('send', { id: done, actor: 'grok', steer: true, text: 'x', requestId: 'img', images: [fake] }));
  const deaf = await start('claude', 'LONG_DEAF');
  await assert.rejects(call('interrupt', { id: deaf, actor: 'grok' }), { code: 'INTERRUPT_UNCONFIRMED' });
  assert.equal((await call('result', { id: deaf, requestId: 'task' })).request.status, 'running', 'Nothing is marked without confirmation.');
});

test('a steered Claude message with no continuation turn settles with the last reply once Claude is idle', t => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'harbor-steer-unit-'));
  const store = new Store(path.join(home, 'state.sqlite'));
  t.after(() => { store.close(); fs.rmSync(home, { recursive: true, force: true }); });
  store.run("INSERT INTO sessions(id,title,provider,project,owner,status,native_id,run_id,pending,created_at,updated_at) VALUES('s','S','claude',?, 'grok','running','native','run',1,'now','now')", home);
  store.run("INSERT INTO runs(id,session_id,tmux_name,started_at) VALUES('run','s','harbor-run','now')");
  for (const [id, text, transport] of [['task', 'Task', 'cli-initial-prompt'], ['steer', 'Steer', 'terminal-steer']])
    store.run("INSERT INTO requests(session_id,request_id,run_id,prompt_hash,payload_hash,status,actor,created_at,transport) VALUES('s',?,'run',?,?,'awaiting_ack','grok','now',?)", id, hashPrompt(text), hashPrompt(text), transport);
  let offset = 0;
  const emit = (name, extra = {}) => acceptEvent(store, store.runRecord('run'), { sessionId: 's', runId: 'run', provider: 'claude', time: new Date(Date.now() + offset).toISOString(), event: { session_id: 'native', cwd: home, prompt_id: 'turn', hook_event_name: name, ...extra } }, ++offset);
  emit('SessionStart'); emit('UserPromptSubmit', { prompt: 'Task' }); emit('UserPromptSubmit', { prompt: 'Steer' });
  emit('Stop', { last_assistant_message: 'Answer with the steer' });
  assert.equal(store.request('s', 'task').status, 'completed');
  assert.equal(store.request('s', 'steer').status, 'running', 'Waiting for a possible continuation turn.');
  assert.equal(store.session('s').pending, 1);
  emit('Notification', { notification_type: 'idle_prompt' });
  assert.equal(store.request('s', 'steer').status, 'completed');
  assert.equal(store.request('s', 'steer').response, 'Answer with the steer');
  assert.equal(store.session('s').status, 'ready');
});
