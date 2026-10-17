import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runScenario, resumePrompt, verifiedTestEvent } from '../live/scenario.mjs';

const project = fileURLToPath(new URL('../fixtures/workspace', import.meta.url));
function fakeHarbor({ loseFirstLaunchResult = false, omitTestEvidence = false } = {}) {
  const sessions = new Map(); const journals = new Map(); const livePids = new Set();
  let pid = 10000; let launchCount = 0; let lost = false; let commandCount = 0;
  const argument = (args, flag) => args[args.indexOf(flag) + 1];
  const clone = data => structuredClone(data);
  async function call(args) {
    commandCount++;
    const [command, id] = args;
    if (command === 'create') {
      const sessionId = argument(args, '--id');
      if (!sessions.has(sessionId)) sessions.set(sessionId, { id: sessionId, provider: argument(args, '--provider'), owner: 'grok', alive: false, requests: {} });
      return clone({ ok: true, session: sessions.get(sessionId) });
    }
    const session = sessions.get(id);
    assert.ok(session, 'The runner may operate only on sessions it created.');
    if (command === 'start' || command === 'resume') {
      const requestId = argument(args, '--request-id');
      if (session.requests[requestId]) return clone({ ok: true, session, request: session.requests[requestId], duplicate: true });
      const prompt = argument(args, '--text');
      if (command === 'start') { launchCount++; session.marker = prompt.match(/harbor-(?:codex|claude)-[a-f0-9]+/)[0]; }
      else { assert.ok(!prompt.includes(session.marker)); assert.ok(!/2\s*\/\s*2/.test(prompt)); }
      session.nativeSessionId ||= randomUUID(); session.runId = randomUUID(); session.pid = ++pid; session.alive = true; livePids.add(session.pid);
      const request = { requestId, status: 'completed', nativeTurnId: randomUUID(), response: `MARCATORE: ${session.marker}\nTESTS: 2/2` };
      session.requests[requestId] = request;
      journals.set(session.runId, command === 'start' && !omitTestEvidence ? [{ sessionId: id, runId: session.runId, provider: session.provider, event: { session_id: session.nativeSessionId, hook_event_name: 'PostToolUse', [session.provider === 'codex' ? 'turn_id' : 'prompt_id']: request.nativeTurnId, tool_input: { command: 'node --test --test-reporter=tap' }, tool_response: '# tests 2\n# pass 2\n# fail 0\n' } }] : []);
      if (loseFirstLaunchResult && !lost) { lost = true; throw new Error('Simulated lost reply after a successful launch.'); }
      return clone({ ok: true, session, request });
    }
    if (command === 'wait') return clone({ ok: true, outcome: 'completed', session, request: session.requests[argument(args, '--request-id')] });
    if (command === 'control') { session.owner = argument(args, '--owner'); return clone({ ok: true, session }); }
    if (command === 'send') { assert.equal(session.owner, 'human'); return { ok: false, error: { code: 'CONTROL_DENIED' } }; }
    if (command === 'stop') { session.alive = false; livePids.delete(session.pid); return clone({ ok: true, session }); }
    throw new Error(`Unexpected operation ${command}`);
  }
  return { call, processExists: id => livePids.has(id), journal: runId => journals.get(runId), get launchCount() { return launchCount; }, get commandCount() { return commandCount; } };
}
function temporaryHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-scenario-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('the live runner exercises four isolated lifecycles and exports no markers or paths', async t => {
  const home = temporaryHome(t); const fake = fakeHarbor();
  const result = await runScenario({ project, home }, fake);
  assert.equal(result.status, 'passed'); assert.deepEqual(result.providers, { codex: 2, claude: 2 });
  assert.equal(result.sessions.length, 4);
  assert.ok(result.sessions.every(session => session.actualTestsPassed && session.humanOwnershipEnforced && session.processExitObserved && session.sameNativeConversation && session.differentProcess && session.markerRecalled && session.resumeUsedNoTools));
  const summary = JSON.stringify(result);
  assert.ok(!summary.includes(project) && !summary.includes(home) && !/harbor-(codex|claude)-/.test(summary));
  const count = fake.commandCount;
  await runScenario({ project, home }, fake);
  assert.equal(fake.commandCount, count, 'Rerunning a complete checkpoint must not dispatch more work.');
});

test('a lost launch response retries the persisted request identity without duplicate sessions', async t => {
  const home = temporaryHome(t); const fake = fakeHarbor({ loseFirstLaunchResult: true });
  await assert.rejects(runScenario({ project, home }, fake), /lost reply/);
  const before = JSON.parse(fs.readFileSync(path.join(home, 'live-scenario.local.json'), 'utf8'));
  const result = await runScenario({ project, home }, fake);
  assert.equal(result.status, 'passed'); assert.equal(fake.launchCount, 4);
  const after = JSON.parse(fs.readFileSync(path.join(home, 'live-scenario.local.json'), 'utf8'));
  assert.deepEqual(Object.values(after.slots).map(s => s.id), Object.values(before.slots).map(s => s.id));
});

test('the runner refuses self-reported success without a native tool result', async t => {
  const home = temporaryHome(t);
  await assert.rejects(runScenario({ project, home }, fakeHarbor({ omitTestEvidence: true })), /no matching successful native tool execution/);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(home, 'live-scenario.local.json'), 'utf8'));
  assert.equal(checkpoint.complete, false); assert.equal(checkpoint.allClosedAt, undefined);
});

test('test evidence is restricted to the primary turn and the resume prompt contains no answer', () => {
  const session = { id: 'local', runId: 'run', provider: 'codex', nativeSessionId: 'native' };
  const request = { nativeTurnId: 'turn' };
  const event = { sessionId: 'local', runId: 'run', provider: 'codex', event: { session_id: 'native', turn_id: 'turn', hook_event_name: 'PostToolUse', tool_input: { command: 'node --test' }, tool_response: '# tests 2\n# pass 2\n# fail 0\n' } };
  assert.ok(verifiedTestEvent([event], session, request));
  assert.equal(verifiedTestEvent([{ ...event, runId: 'foreign' }], session, request), undefined);
  assert.equal(verifiedTestEvent([{ ...event, event: { ...event.event, agent_id: 'child' } }], session, request), undefined);
  assert.ok(!/2\s*\/\s*2|harbor-(codex|claude)-/.test(resumePrompt()));
});
