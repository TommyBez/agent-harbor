import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../broker/store.mjs';
import { acceptEvent } from '../../broker/events.mjs';
import { hashPrompt } from '../../broker/common.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-events-review-'));
  const store = new Store(path.join(home, 'state.sqlite'));
  t.after(() => { store.close(); fs.rmSync(home, { recursive: true, force: true }); });
  store.run('INSERT INTO sessions(id,title,provider,project,owner,status,native_id,run_id,pending,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', 'session', 'Fixture', 'codex', '/fixture', 'grok', 'starting', 'native', 'run', 1, '2026-01-01', '2026-01-01');
  store.run('INSERT INTO runs(id,session_id,tmux_name,started_at) VALUES(?,?,?,?)', 'run', 'session', 'harbor-run', '2026-01-01');
  store.run('INSERT INTO requests(session_id,request_id,run_id,prompt_hash,payload_hash,status,actor,created_at,transport) VALUES(?,?,?,?,?,?,?,?,?)', 'session', 'request', 'run', hashPrompt('Task'), hashPrompt('Task'), 'awaiting_ack', 'grok', '2026-01-01', 'terminal-paste');
  let offset = 0;
  const emit = (event, extra = {}) => {
    acceptEvent(store, store.runRecord('run'), { sessionId: 'session', runId: 'run', provider: 'codex', time: new Date().toISOString(), event: { session_id: 'native', cwd: '/fixture', turn_id: 'turn', hook_event_name: event, ...extra } }, ++offset);
  };
  return { store, emit };
}

test('post-Stop tool activity reopens the primary turn and the later Stop replaces its intermediate response', t => {
  const { store, emit } = fixture(t);
  emit('UserPromptSubmit', { prompt: 'Task' });
  emit('Stop', { last_assistant_message: 'Intermediate response' });
  emit('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'test' } });
  assert.equal(store.session('session').pending, 1, 'A continuing turn must block another bot prompt.');
  assert.notEqual(store.request('session', 'request').status, 'completed', 'A request resumed by native hooks is not finished.');
  emit('Stop', { last_assistant_message: 'Actual final response' });
  assert.equal(store.request('session', 'request').response, 'Actual final response');
  assert.equal(store.request('session', 'request').status, 'completed');
  assert.equal(store.session('session').pending, 0);
});

test('a Stop waiting on native background tasks cannot report request completion', t => {
  const { store, emit } = fixture(t);
  emit('UserPromptSubmit', { prompt: 'Task' });
  emit('Stop', { last_assistant_message: 'Waiting', background_tasks: [{ id: 'background-worker' }] });
  assert.equal(store.session('session').pending, 1);
  assert.notEqual(store.request('session', 'request').status, 'completed');
  emit('Stop', { last_assistant_message: 'Worker finished', background_tasks: [] });
  assert.equal(store.request('session', 'request').status, 'completed');
  assert.equal(store.request('session', 'request').response, 'Worker finished');
});

test('a subagent cannot acknowledge or complete a parent request', t => {
  const { store, emit } = fixture(t);
  emit('UserPromptSubmit', { prompt: 'Task', agent_id: 'child' });
  emit('Stop', { last_assistant_message: 'Wrong answer', agent_id: 'child' });
  assert.equal(store.request('session', 'request').accepted_at, null);
  assert.equal(store.request('session', 'request').response, null);
  assert.equal(store.session('session').pending, 1);
});

test('an identity incident remains visible after later normal lifecycle events', t => {
  const { store, emit } = fixture(t);
  emit('UserPromptSubmit', { prompt: 'Task' });
  emit('Stop', { session_id: 'foreign-native', last_assistant_message: 'Foreign' });
  assert.equal(store.runRecord('run').attention, 'HOOK_NATIVE_ID_MISMATCH');
  emit('Stop', { last_assistant_message: 'Legitimate but incomplete recovery evidence' });
  assert.equal(store.session('session').status, 'attention', 'Normal hook traffic must not silently clear an identity incident.');
  assert.equal(store.session('session').error, 'HOOK_NATIVE_ID_MISMATCH');
});
