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
import { configuration, executable } from '../../broker/common.mjs';
const fake = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
let tmux = process.env.HARBOR_TEST_TMUX;
try { tmux ||= executable('tmux', { env: process.env, executables: {}, home: os.tmpdir() }); } catch {}
const supported = !!tmux && fs.existsSync(tmux);
async function environment() {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'harbor-test-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ executables: { tmux, claude: fake, codex: fake } }));
  const project = path.join(home, 'project'); fs.mkdirSync(project);
  const config = configuration({ ...process.env, HARBOR_HOME: home });
  const call = (action, args = {}) => rpc(action, args, { config });
  const cleanup = async () => {
    try { const pid = JSON.parse(fs.readFileSync(path.join(home, 'daemon.lock/owner.json'))).pid; process.kill(pid, 'SIGTERM'); } catch {}
    try { execFileSync(tmux, ['-S', config.tmuxSocket, 'kill-server'], { stdio: 'ignore' }); } catch {}
    await delay(100);
    fs.rmSync(home, { recursive: true, force: true });
  };
  return { home, project, config, call, cleanup };
}

test('four independent interactive CLI sessions: exact resume, ownership, idempotency and daemon crash', { skip: !supported, timeout: 30000 }, async () => {
  const env = await environment(); const { call, project } = env;
  try {
    const states = await Promise.all(['codex', 'codex', 'claude', 'claude'].map(async (provider, i) => {
      const id = randomUUID();
      const created = await call('create', { id, provider, project, title: 'Session ' + i, owner: 'grok' });
      assert.equal(created.session.id, id);
      const duplicate = await call('create', { id, provider, project, title: 'Session ' + i, owner: 'grok' });
      assert.equal(duplicate.duplicate, true);
      const requestId = 'start-' + i;
      const started = await call('start', { id, actor: 'grok', text: 'MARKER:secret-' + i, requestId });
      const completed = await call('wait', { id, requestId, timeout: 5000 });
      assert.equal(completed.outcome, 'completed');
      assert.ok(completed.session.nativeSessionId);
      assert.equal(completed.request.response, 'ANSWER:MARKER:secret-' + i);
      return { id, provider, requestId, original: completed.session };
    }));
    const list = await call('list', { compact: true });
    assert.equal(list.sessions.length, 4);
    assert.equal('lastResponse' in list.sessions[0], false);
    const first = states[0];
    const duplicate = await call('send', { id: first.id, actor: 'grok', text: 'MARKER:secret-0', requestId: first.requestId });
    assert.equal(duplicate.duplicate, true);
    await assert.rejects(call('send', { id: first.id, actor: 'grok', text: 'MARKER:secret-0 ', requestId: first.requestId }), { code: 'REQUEST_ID_CONFLICT' });
    await call('control', { id: first.id, owner: 'human', actor: 'human' });
    await assert.rejects(call('send', { id: first.id, actor: 'grok', text: 'blocked', requestId: 'blocked' }), { code: 'CONTROL_DENIED' });
    await assert.rejects(call('control', { id: first.id, owner: 'grok', actor: 'grok' }), { code: 'CONTROL_DENIED' });
    await call('control', { id: first.id, owner: 'grok', actor: 'human' });
    // SIGKILL leaves the durable lock behind; a fresh daemon must adopt the same PTYs.
    const doctor = await call('doctor');
    process.kill(doctor.daemonPid, 'SIGKILL');
    await delay(150);
    const recovered = await call('list');
    assert.equal(recovered.sessions.length, 4);
    for (const state of states) {
      const current = recovered.sessions.find(s => s.id === state.id);
      assert.equal(current.pid, state.original.pid);
      assert.equal(current.nativeSessionId, state.original.nativeSessionId);
      assert.equal(current.alive, true);
    }
    await Promise.all(states.map(async state => {
      const closed = await call('stop', { id: state.id, actor: 'grok' });
      assert.equal(closed.session.alive, false);
      assert.throws(() => process.kill(state.original.pid, 0), { code: 'ESRCH' });
      await call('resume', { id: state.id, actor: 'grok', text: 'RECALL', requestId: 'resume' });
      const resumed = await call('wait', { id: state.id, requestId: 'resume', timeout: 5000 });
      assert.equal(resumed.outcome, 'completed');
      assert.equal(resumed.session.nativeSessionId, state.original.nativeSessionId);
      assert.notEqual(resumed.session.pid, state.original.pid);
      assert.ok(fs.existsSync(path.join(env.home, 'runs', state.original.runId, 'final-screen.txt')));
      assert.throws(() => execFileSync(tmux, ['-S', env.config.tmuxSocket, 'has-session', '-t', 'harbor-' + state.original.runId], { stdio: 'ignore' }));
      assert.match(resumed.request.response, /^MEMORY:secret-\d$/);
    }));
    const splitState = (await call('result', { id: first.id })).session;
    execFileSync(tmux, ['-S', env.config.tmuxSocket, 'split-window', '-d', '-t', 'harbor-' + splitState.runId, '/bin/cat']);
    execFileSync(tmux, ['-S', env.config.tmuxSocket, 'select-pane', '-t', 'harbor-' + splitState.runId + ':.1']);
    await call('send', { id: first.id, actor: 'grok', text: 'SPLIT_SAFE', requestId: 'split' });
    const splitResult = await call('wait', { id: first.id, requestId: 'split', timeout: 5000 });
    assert.equal(splitResult.request.response, 'ANSWER:SPLIT_SAFE');
    assert.equal(splitResult.session.pid, splitState.pid);
    await call('stop', { id: first.id, actor: 'grok' });
    await call('resume', { id: first.id, actor: 'grok', text: 'RECALL', requestId: 'resume-with-split' });
    await call('wait', { id: first.id, requestId: 'resume-with-split', timeout: 5000 });
    assert.doesNotThrow(() => execFileSync(tmux, ['-S', env.config.tmuxSocket, 'has-session', '-t', 'harbor-' + splitState.runId], { stdio: 'ignore' }), 'A historical run with a living secondary pane must remain intact.');
    const events = await call('events', { id: first.id });
    assert.ok(events.events.some(e => e.event.hook_event_name === 'PostToolUse'));
    assert.ok(events.nextCursor > 0);
    assert.equal(fs.statSync(env.home).mode & 0o777, 0o700);
    assert.equal(fs.statSync(env.config.socket).mode & 0o777, 0o600);
  } finally { await env.cleanup(); }
});

test('attention differs from completion; continued Stop updates response; takeover fences a pending send', { skip: !supported, timeout: 20000 }, async () => {
  const env = await environment(); const { call, project } = env;
  try {
    const id = (await call('create', { provider: 'claude', project, title: 'Boundaries', owner: 'grok', text: 'READY', requestId: 'initial' })).session.id;
    await call('wait', { id, requestId: 'initial', timeout: 5000 });
    await call('send', { id, actor: 'grok', text: 'AFTER_STOP', requestId: 'continued' });
    const result = await call('wait', { id, requestId: 'continued', timeout: 5000 });
    assert.equal(result.request.response, 'final');
    const sending = call('send', { id, actor: 'grok', text: 'do not submit', requestId: 'takeover' });
    await delay(100);
    await call('control', { id, owner: 'human', actor: 'human' });
    await assert.rejects(sending, { code: 'CONTROL_DENIED' });
    const interrupted = await call('result', { id, requestId: 'takeover' });
    assert.equal(interrupted.request.status, 'uncertain');
    assert.equal(interrupted.session.owner, 'human');
    await assert.rejects(call('control', { id, owner: 'grok', actor: 'human' }), { code: 'TURN_PENDING' });
    const blockedId = (await call('create', { provider: 'codex', project, title: 'Permission', owner: 'grok', text: 'BLOCK', requestId: 'blocked' })).session.id;
    const attention = await call('wait', { id: blockedId, requestId: 'blocked', timeout: 5000 });
    assert.equal(attention.outcome, 'attention');
    assert.equal(attention.session.error, 'PERMISSION_REQUIRED');
    assert.notEqual(attention.request.status, 'completed');
  } finally { await env.cleanup(); }
});
