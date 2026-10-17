#!/usr/bin/env node
/** Explicit live test. Importing this module never starts a CLI or changes trust. */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE_FILES = ['README.md', 'AGENTS.md', 'src/invoice.mjs', 'invoice.test.mjs'];
const timestamp = () => new Date().toISOString();

export function assert(condition, message) { if (!condition) throw new Error(message); }
export function processExists(pid) {
  assert(Number.isInteger(pid) && pid > 0, 'Missing process identity.');
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
export function writePrivateJSON(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, filename);
}
export function initialPrompt(marker) {
  return `Analizza soltanto questo progetto di prova. Leggi README.md, src/invoice.mjs e invoice.test.mjs, poi esegui node --test --test-reporter=tap. Non modificare né creare file. Memorizza nella conversazione il marcatore ${marker}; non salvarlo su disco. Rispondi con una breve descrizione del modulo e due righe finali esatte: MARCATORE: ${marker} e TESTS: <passati>/<totali>, usando il risultato reale del comando.`;
}
export function resumePrompt() {
  return 'Questa è la continuazione della medesima conversazione dopo la chiusura e il riavvio della CLI. Senza usare strumenti, leggere file o rieseguire test, recupera dalla conversazione precedente il tuo marcatore e il risultato dei test. Rispondi soltanto con due righe: MARCATORE: <marcatore ricordato> e TESTS: <passati>/<totali>. Non inventare i dati se non li ricordi.';
}
export function verifyResponse(response, marker) {
  assert(typeof response === 'string', 'The native CLI did not return a textual response.');
  assert(response.includes(`MARCATORE: ${marker}`), 'The response did not recall this session’s exact marker.');
  assert(/TESTS:\s*2\s*\/\s*2\b/.test(response), 'The response did not report the expected 2/2 test result.');
  return { exactMarker: true, reportedTests: '2/2' };
}
export function verifiedTestEvent(entries, session, request) {
  return entries.find(entry => {
    const event = entry.event;
    if (entry.sessionId !== session.id || entry.runId !== session.runId || entry.provider !== session.provider || event?.session_id !== session.nativeSessionId || event?.agent_id || event?.hook_event_name !== 'PostToolUse') return false;
    const turn = event[session.provider === 'codex' ? 'turn_id' : 'prompt_id'];
    if (!request.nativeTurnId || turn !== request.nativeTurnId) return false;
    const command = event.tool_input?.command || event.tool_input?.cmd || '';
    if (!/\bnode\s+--test\b/.test(command)) return false;
    const output = typeof event.tool_response === 'string' ? event.tool_response : JSON.stringify(event.tool_response || {});
    return /(?:^|\s|\\n)(?:#\s*)?tests\s+2\b/.test(output) && /(?:^|\s|\\n)(?:#\s*)?pass\s+2\b/.test(output) && /(?:^|\s|\\n)(?:#\s*)?fail\s+0\b/.test(output);
  });
}
export function fixtureDigest(project) {
  const hashes = {};
  for (const name of FIXTURE_FILES) hashes[name] = createHash('sha256').update(fs.readFileSync(path.join(project, name))).digest('hex');
  return hashes;
}
function journal(home, runId) {
  assert(typeof runId === 'string' && /^[a-f0-9-]{36}$/i.test(runId), 'Invalid run identity in the CLI response.');
  const contents = fs.readFileSync(path.join(home, 'runs', runId, 'events.jsonl'), 'utf8');
  return contents.split('\n').filter(Boolean).map(line => JSON.parse(line));
}
export function sanitizedSummary(checkpoint) {
  const slots = Object.values(checkpoint.slots);
  return {
    schemaVersion: 1, experiment: 'four-original-interactive-cli-sessions', runId: checkpoint.runId,
    status: checkpoint.complete ? 'passed' : 'incomplete', startedAt: checkpoint.createdAt, completedAt: checkpoint.completedAt || null,
    providers: { codex: slots.filter(slot => slot.provider === 'codex').length, claude: slots.filter(slot => slot.provider === 'claude').length },
    sessions: slots.map(slot => ({
      label: slot.label, provider: slot.provider,
      actualTestsPassed: !!slot.analysisVerified?.testExecutionObserved,
      tests: slot.analysisVerified?.reportedTests || null,
      humanOwnershipEnforced: !!slot.ownershipVerified,
      processExitObserved: !!slot.closedVerified,
      sameNativeConversation: !!slot.resumeVerified?.sameNativeConversation,
      differentProcess: !!slot.resumeVerified?.differentProcess,
      markerRecalled: !!slot.resumeVerified?.exactMarker,
      resumeUsedNoTools: !!slot.resumeVerified?.noToolsObserved,
    })),
    allProcessesClosedTogether: !!checkpoint.allClosedAt,
    fixtureUnchanged: !!checkpoint.fixtureUnchanged,
    limitations: ['Normal CLI trust and permission prompts remain in force.', 'This scenario does not certify a full Mac reboot or every terminal feature.'],
  };
}
export function createCheckpoint(project, home) {
  const runId = randomUUID();
  return {
    schemaVersion: 1, runId, project, home, createdAt: timestamp(), complete: false, operations: {}, errors: [],
    fixture: fixtureDigest(project),
    slots: Object.fromEntries(['codex-1', 'codex-2', 'claude-1', 'claude-2'].map(label => {
      const provider = label.split('-')[0];
      return [label, { label, provider, id: randomUUID(), marker: `harbor-${provider}-${randomBytes(12).toString('hex')}`, launchRequestId: `${runId}/${label}/launch`, resumeRequestId: `${runId}/${label}/resume`, deniedRequestId: `${runId}/${label}/denied` }];
    })),
  };
}

/** A checkpointed orchestrator. The injected client allows tests without CLI/API calls. */
export async function runScenario(options, dependencies = {}) {
  const project = fs.realpathSync(options.project);
  const home = path.resolve(options.home);
  const checkpointPath = options.checkpoint || path.join(home, 'live-scenario.local.json');
  const reportPath = options.report || path.join(home, 'live-summary.json');
  assert(!checkpointPath.startsWith(project + path.sep) && !reportPath.startsWith(project + path.sep), 'Checkpoint and report must remain outside the agent fixture.');
  const checkpoint = fs.existsSync(checkpointPath) ? JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) : createCheckpoint(project, home);
  assert(checkpoint.schemaVersion === 1 && checkpoint.project === project && checkpoint.home === home, 'The checkpoint belongs to a different scenario or workspace.');
  const save = () => writePrivateJSON(checkpointPath, checkpoint);
  const report = () => writePrivateJSON(reportPath, sanitizedSummary(checkpoint));
  const alive = dependencies.processExists || processExists;
  const readJournal = dependencies.journal || ((runId) => journal(home, runId));
  const call = dependencies.call || (async args => {
    let output;
    try {
      output = await execFileAsync(process.execPath, [path.join(ROOT, 'bin/harbor.mjs'), ...args], { cwd: ROOT, env: { ...process.env, HARBOR_HOME: home }, encoding: 'utf8', timeout: 240_000, maxBuffer: 4 * 1024 * 1024 });
    } catch (error) {
      try { const result = JSON.parse(error.stdout || error.stderr); if (typeof result?.ok === 'boolean') return result; } catch {}
      throw new Error(`Harbor command did not provide a definite result (${error.code || 'unknown'}). The checkpoint is retained; retry only this same scenario.`);
    }
    const result = JSON.parse(output.stdout);
    assert(typeof result.ok === 'boolean', 'Harbor returned an unrecognized response envelope.');
    return result;
  });
  const successful = async args => {
    const result = await call(args);
    assert(result.ok, `Harbor ${args[0]} failed: ${result.error?.code || result.code || 'UNKNOWN'}: ${result.error?.message || result.error || ''}`);
    return result;
  };
  // Every effect below is retry-safe: create uses a pre-persisted UUID; delivery
  // uses a pre-persisted request ID; state changes set a target value, not a toggle.
  const operation = async (key, fn) => {
    if (checkpoint.operations[key]?.state === 'done') return checkpoint.operations[key].result;
    checkpoint.operations[key] = { state: 'intent', firstAttemptAt: checkpoint.operations[key]?.firstAttemptAt || timestamp(), lastAttemptAt: timestamp() }; save();
    const result = await fn();
    checkpoint.operations[key] = { ...checkpoint.operations[key], state: 'done', completedAt: timestamp(), result }; save();
    return result;
  };
  const completed = async (slot, requestId) => {
    const result = await successful(['wait', slot.id, '--request-id', requestId, '--timeout', '180000']);
    assert(result.outcome === 'completed' && result.request?.status === 'completed', `Session ${slot.label} needs attention or is unfinished (${result.outcome}). Resolve normal CLI prompts in the app and rerun this same checkpoint.`);
    assert(result.session?.id === slot.id && result.session?.nativeSessionId, 'The completed response has no matching session identity.');
    return result;
  };
  save();
  if (checkpoint.complete) return sanitizedSummary(checkpoint);
  try {
    assert(JSON.stringify(fixtureDigest(project)) === JSON.stringify(checkpoint.fixture), 'Fixture files changed since this scenario began.');
    const slots = Object.values(checkpoint.slots);
    // Launch all four before awaiting the first completion, exercising N-session routing.
    for (const slot of slots) {
      await operation(`${slot.label}/create`, () => successful(['create', '--id', slot.id, '--provider', slot.provider, '--project', project, '--title', `Harbor live ${slot.label}`, '--owner', 'grok']));
      const launched = await operation(`${slot.label}/launch`, () => successful(['start', slot.id, '--text', initialPrompt(slot.marker), '--request-id', slot.launchRequestId, '--actor', 'grok']));
      slot.initialProcess = launched.session; save();
    }
    for (const slot of slots) {
      const result = await operation(`${slot.label}/analysis`, () => completed(slot, slot.launchRequestId));
      verifyResponse(result.request.response, slot.marker);
      const event = verifiedTestEvent(readJournal(result.session.runId), result.session, result.request);
      assert(event, `Session ${slot.label} claimed tests but no matching successful native tool execution was observed.`);
      slot.initialProcess = result.session;
      slot.analysisVerified = { ...verifyResponse(result.request.response, slot.marker), testExecutionObserved: true, nativeTurnId: result.request.nativeTurnId };
      save();
    }
    const nativeIds = new Set(slots.map(slot => slot.initialProcess.nativeSessionId));
    assert(nativeIds.size === slots.length, 'Native conversation IDs unexpectedly overlap.');
    for (const slot of slots) {
      await operation(`${slot.label}/human`, () => successful(['control', slot.id, '--owner', 'human', '--actor', 'human']));
      const denied = await operation(`${slot.label}/denied`, async () => {
        const result = await call(['send', slot.id, '--text', 'This request must be rejected before delivery.', '--request-id', slot.deniedRequestId, '--actor', 'grok']);
        assert(result.ok === false && (result.error?.code || result.code) === 'CONTROL_DENIED', 'Grok input was not rejected while the human owned the session.');
        return { controlDenied: true };
      });
      slot.ownershipVerified = denied.controlDenied; save();
      await operation(`${slot.label}/grok`, () => successful(['control', slot.id, '--owner', 'grok', '--actor', 'human']));
    }
    for (const slot of slots) {
      const stopped = await operation(`${slot.label}/stop`, () => successful(['stop', slot.id, '--actor', 'grok']));
      assert(stopped.session?.id === slot.id && stopped.session?.nativeSessionId === slot.initialProcess.nativeSessionId && stopped.session?.alive === false, 'Stop did not retain the exact native identity and confirm process exit.');
      assert(!alive(slot.initialProcess.pid), `Session ${slot.label}'s original process is still alive.`);
      slot.closedVerified = true; save();
    }
    if (!checkpoint.allClosedAt) {
      for (const slot of slots) assert(!alive(slot.initialProcess.pid), 'Not all original processes were absent together.');
      checkpoint.allClosedAt = timestamp(); save();
    }
    // Resume prompts contain no expected marker or test values.
    for (const slot of slots) {
      await operation(`${slot.label}/resume`, () => successful(['resume', slot.id, '--text', resumePrompt(), '--request-id', slot.resumeRequestId, '--actor', 'grok']));
    }
    for (const slot of slots) {
      const result = await operation(`${slot.label}/recall`, () => completed(slot, slot.resumeRequestId));
      const response = verifyResponse(result.request.response, slot.marker);
      assert(result.session.nativeSessionId === slot.initialProcess.nativeSessionId, `Session ${slot.label} resumed a different conversation.`);
      assert(result.session.pid !== slot.initialProcess.pid && alive(result.session.pid), `Session ${slot.label} did not restart into a new live process.`);
      const toolEvents = readJournal(result.session.runId).filter(entry => entry.sessionId === slot.id && entry.event?.session_id === result.session.nativeSessionId && !entry.event?.agent_id && entry.event?.hook_event_name === 'PostToolUse' && entry.event[slot.provider === 'codex' ? 'turn_id' : 'prompt_id'] === result.request.nativeTurnId);
      assert(toolEvents.length === 0, `Session ${slot.label} used tools to recover its marker.`);
      slot.resumedProcess = result.session;
      slot.resumeVerified = { ...response, sameNativeConversation: true, differentProcess: true, noToolsObserved: true, nativeTurnId: result.request.nativeTurnId }; save();
    }
    assert(JSON.stringify(fixtureDigest(project)) === JSON.stringify(checkpoint.fixture), 'The live test modified fixture files.');
    checkpoint.fixtureUnchanged = true; checkpoint.complete = true; checkpoint.completedAt = timestamp(); save(); report();
    return sanitizedSummary(checkpoint);
  } catch (error) {
    checkpoint.errors.push({ time: timestamp(), message: error.message }); save(); report(); throw error;
  }
}

function readOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    assert(['--project', '--home', '--checkpoint', '--report'].includes(flag) && argv[index + 1], 'Usage: node test/live/scenario.mjs --project PATH --home PATH [--checkpoint PRIVATE_PATH] [--report PATH]');
    options[flag.slice(2)] = path.resolve(argv[index + 1]);
  }
  assert(options.project && options.home, 'Select --project and --home explicitly. No live sessions were started.');
  return options;
}
function acquireLock(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  if (fs.existsSync(filename)) {
    let saved;
    try { saved = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { throw new Error('Scenario lock is unreadable; inspect it before retrying.'); }
    assert(!processExists(saved.pid), 'This scenario is already running.');
    fs.unlinkSync(filename);
  }
  const token = randomUUID();
  fs.writeFileSync(filename, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
  return () => { try { if (JSON.parse(fs.readFileSync(filename, 'utf8')).token === token) fs.unlinkSync(filename); } catch {} };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let release;
  try {
    const options = readOptions(process.argv.slice(2));
    release = acquireLock(`${options.checkpoint || path.join(options.home, 'live-scenario.local.json')}.lock`);
    console.log(JSON.stringify({ ok: true, ...await runScenario(options) }, null, 2));
  } catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
  finally { release?.(); }
}
