import fs from 'node:fs';
import path from 'node:path';
import { usesWorktree, worktreeOf } from './arguments.mjs';
import { hashPrompt, now } from './common.mjs';
import { withoutCodexImagePrefix } from './images.mjs';

const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
// StopFailure types after which the CLI is idle at its prompt and nobody has to act: the request records the failure.
// Not rate_limit (Claude may open its usage-limit menu or auto-continue) nor invalid_request (a full context needs /compact).
const TRANSIENT_FAILURES = new Set(['overloaded', 'server_error', 'max_output_tokens']);
const real = directory => { try { return fs.realpathSync(directory); } catch { return path.resolve(directory); } };
export function importEvents(store, config, run) {
  if (['HOOK_JOURNAL_TRUNCATED', 'HOOK_JOURNAL_CORRUPT', 'HOOK_EVENT_TOO_LARGE'].includes(run.attention)) return;
  const filename = path.join(config.home, 'runs', run.id, 'events.jsonl');
  if (!fs.existsSync(filename)) return;
  const size = fs.statSync(filename).size;
  if (size < run.offset) { incident(store, run, 'HOOK_JOURNAL_TRUNCATED'); return; }
  if (size === run.offset) return;
  const fd = fs.openSync(filename, 'r');
  const buffer = Buffer.alloc(Math.min(size - run.offset, 8 * 1024 * 1024));
  try { fs.readSync(fd, buffer, 0, buffer.length, run.offset); } finally { fs.closeSync(fd); }
  const lastNewline = buffer.lastIndexOf(10);
  if (lastNewline < 0) { if (buffer.length >= 4 * 1024 * 1024) incident(store, run, 'HOOK_EVENT_TOO_LARGE'); return; }
  let offset = run.offset;
  store.transaction(() => {
    for (const line of buffer.subarray(0, lastNewline + 1).toString('utf8').split('\n').slice(0, -1)) {
      const start = offset;
      offset += Buffer.byteLength(line) + 1;
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { incident(store, run, 'HOOK_JOURNAL_CORRUPT', { offset: start }); continue; }
      acceptEvent(store, run, entry, start);
    }
    store.run('UPDATE runs SET offset = ? WHERE id = ?', offset, run.id);
  });
}
// Claude runs one turn at a time. When a new turn shows up while an older request still runs and its turn never stopped
// (an Esc interrupt fires no hook, or a legacy rule dropped its Stop), that request is over: superseded by the human, or
// marked RESULT_NOT_OBSERVED by recovery. A Stop recorded with background work is a real end of turn and is left alone.
function closeOrphans(store, run, session, turnId, time) {
  if (session.provider !== 'claude') return;
  store.run("UPDATE requests SET status = 'interrupted', error = CASE WHEN error = 'RESULT_NOT_OBSERVED' THEN error ELSE 'TURN_SUPERSEDED' END, completed_at = ? WHERE run_id = ? AND status = 'running' AND native_turn_id IS NOT NULL AND native_turn_id != ? AND native_turn_id NOT IN (SELECT turn_id FROM events WHERE run_id = ? AND turn_id IS NOT NULL AND event_name IN ('Stop','StopFailure'))", time, run.id, turnId, run.id);
}
// Claude went idle without the continuation turn that steered messages were waiting for: its last reply answered them.
function settleSteers(store, run, session, time) {
  const open = store.all("SELECT r.request_id FROM requests r WHERE r.run_id = ? AND r.transport = 'terminal-steer' AND r.status = 'running' AND EXISTS (SELECT 1 FROM events e WHERE e.run_id = r.run_id AND e.turn_id = r.native_turn_id AND e.event_name IN ('Stop','StopFailure'))", run.id);
  if (!open.length) return;
  for (const steer of open) store.run("UPDATE requests SET status = 'completed', response = ?, error = NULL, completed_at = ? WHERE session_id = ? AND request_id = ?", session.last_response, time, session.id, steer.request_id);
  store.run("UPDATE sessions SET pending = 0, status = 'ready', error = NULL WHERE id = ?", session.id);
}
// A legacy recovery left this run's turn unknown (active_turn NULL) and the CLI has not named it yet. The marker is the
// recovery's own audit row, which no display state can overwrite.
function unknownTurn(store, run, session) {
  return session.provider === 'claude' && !session.active_turn && !!store.get("SELECT 1 FROM audit WHERE session_id = ? AND action = 'cwd_incident_cleared' AND json_extract(details, '$.runId') = ? AND json_extract(details, '$.state') = 'unknown' LIMIT 1", session.id, run.id);
}
// The CLI's first event that carries a prompt ID after such a recovery names the running turn.
function adoptUnknownTurn(store, run, session, turnId, time) {
  if (!turnId || !unknownTurn(store, run, session)) return;
  closeOrphans(store, run, session, turnId, time);
  store.run('UPDATE sessions SET active_turn = ? WHERE id = ?', turnId, session.id);
  session.active_turn = turnId;
}
export function incident(store, run, code, details = {}) {
  if (store.runRecord(run.id)?.attention === code) return;
  store.run('UPDATE runs SET attention = ? WHERE id = ?', code, run.id);
  store.run('UPDATE sessions SET status = ?, error = ?, updated_at = ? WHERE id = ? AND run_id = ?', 'attention', code, now(), run.session_id, run.id);
  store.audit(code, run.session_id, { runId: run.id, ...details });
}
export function acceptEvent(store, run, entry, offset) {
  const session = store.session(run.session_id);
  const e = entry.event;
  if (entry.sessionId !== session.id || entry.runId !== run.id || entry.provider !== session.provider || !e || typeof e.hook_event_name !== 'string') { incident(store, run, 'HOOK_IDENTITY_MISMATCH', { offset }); return; }
  if (e.agent_id) return; // Subagents do not complete the primary CLI conversation.
  if (typeof e.session_id !== 'string' || !e.session_id) { incident(store, run, 'HOOK_SESSION_MISSING', { offset }); return; }
  if (session.native_id && session.native_id !== e.session_id) { incident(store, run, 'HOOK_NATIVE_ID_MISMATCH', { offset }); return; }
  if (!session.native_id && !['SessionStart', 'UserPromptSubmit'].includes(e.hook_event_name)) return;
  // cwd is the CLI's current directory. Codex keeps it fixed for a session, but Claude's follows the Bash tool's cd,
  // --add-dir folders and worktrees, so for Claude only the run's first accepted event must start where Harbor launched it.
  // Identity rests on the launch environment and the native session ID either way.
  if (e.cwd && real(e.cwd) !== real(session.working_directory || session.project)) {
    if (!session.working_directory && usesWorktree(session) && ['SessionStart','UserPromptSubmit'].includes(e.hook_event_name) && worktreeOf(session.project, e.cwd)) {
      store.run('UPDATE sessions SET working_directory = ? WHERE id = ?', real(e.cwd), session.id);
      session.working_directory = real(e.cwd);
    } else if (session.provider === 'codex' || !store.runRecord(run.id).hooks_ready) { incident(store, run, 'HOOK_PROJECT_MISMATCH', { offset }); return; }
  }
  const time = typeof entry.time === 'string' ? entry.time : now();
  const turnId = e[session.provider === 'codex' ? 'turn_id' : 'prompt_id'] || null;
  const inserted = store.run('INSERT OR IGNORE INTO events(run_id,source_offset,time,event_name,native_id,turn_id,payload) VALUES(?,?,?,?,?,?,?)', run.id, offset, time, e.hook_event_name, e.session_id, turnId, JSON.stringify(e));
  if (!inserted.changes) return;
  store.run('UPDATE sessions SET native_id = COALESCE(native_id, ?), updated_at = ? WHERE id = ?', e.session_id, time, session.id);
  store.run('UPDATE runs SET hooks_ready = 1 WHERE id = ?', run.id);
  if (session.run_id !== run.id) return; // Late output remains historical, never changes a new process.
  const event = e.hook_event_name;
  // Claude answers a message typed while it was writing (no tool boundary left) in a turn of its own, with a new prompt
  // ID and no UserPromptSubmit. Once the active turn has stopped, a new prompt ID is that continuation, not a mismatch.
  if (session.provider === 'claude' && turnId && session.active_turn && turnId !== session.active_turn && event !== 'UserPromptSubmit'
    && store.get("SELECT 1 FROM events WHERE run_id = ? AND turn_id = ? AND event_name IN ('Stop','StopFailure') LIMIT 1", run.id, session.active_turn)) {
    store.run("UPDATE requests SET native_turn_id = ? WHERE run_id = ? AND native_turn_id = ? AND transport = 'terminal-steer' AND status = 'running'", turnId, run.id, session.active_turn);
    store.run("UPDATE sessions SET active_turn = ?, pending = 1, status = 'running', error = NULL WHERE id = ?", turnId, session.id);
    session.active_turn = turnId; session.pending = 1;
  }
  if (event === 'UserPromptSubmit') {
    if (!turnId) { incident(store, run, 'HOOK_TURN_ID_MISSING'); return; }
    closeOrphans(store, run, session, turnId, time);
    const hash = typeof e.prompt === 'string' ? hashPrompt(e.prompt) : null;
    let request = hash ? store.get("SELECT * FROM requests WHERE run_id = ? AND prompt_hash = ? AND accepted_at IS NULL AND status IN ('intent','delivering','awaiting_ack','uncertain') ORDER BY created_at LIMIT 1", run.id, hash) : null;
    if (!request && hash && session.provider === 'codex') {
      const pending = store.all("SELECT * FROM requests WHERE run_id = ? AND accepted_at IS NULL AND status IN ('intent','delivering','awaiting_ack','uncertain') ORDER BY created_at", run.id);
      request = pending.find(candidate => {
        const count = JSON.parse(candidate.images_json || '[]').length;
        const text = count ? withoutCodexImagePrefix(e.prompt, count) : null;
        return text !== null && hashPrompt(text) === candidate.prompt_hash;
      });
    }
    // The CLI's own prompt hook proves delivery, so an earlier delivery error no longer applies.
    if (request) store.run('UPDATE requests SET status = ?, accepted_at = ?, native_turn_id = ?, error = NULL WHERE session_id = ? AND request_id = ?', 'running', time, turnId, session.id, request.request_id);
    store.run('UPDATE sessions SET pending = 1, active_turn = ?, status = ?, error = NULL WHERE id = ?', turnId, 'running', session.id);
  } else if (event === 'Notification') {
    // Idle at its prompt: a message still waiting for a continuation turn was answered by the last reply after all.
    if (e.notification_type === 'idle_prompt' && session.provider === 'claude') settleSteers(store, run, session, time);
    // Claude notifies only when its own dialog is actually waiting for the human, not when a hook or auto mode answered.
    const code = e.notification_type === 'permission_prompt' ? 'PERMISSION_REQUIRED' : ['elicitation_dialog', 'elicitation_url_dialog'].includes(e.notification_type) ? 'CLI_ATTENTION_REQUIRED' : null;
    if (code) { adoptUnknownTurn(store, run, session, turnId, time); store.run('UPDATE sessions SET status = ?, error = ? WHERE id = ?', 'attention', code, session.id); }
  } else if (event === 'PermissionRequest') {
    // Approval routing started; a reviewer or another hook may answer it. Service.refresh raises attention only if the
    // CLI then stays silent (Codex), and Claude reports a waiting dialog through its permission_prompt Notification.
  } else if (['PostToolUse', 'PostToolUseFailure', 'PermissionDenied'].includes(event)) {
    adoptUnknownTurn(store, run, session, turnId, time);
    if (turnId && turnId === session.active_turn && !run.attention) {
      store.run("UPDATE requests SET status = 'running', completed_at = NULL WHERE run_id = ? AND native_turn_id = ? AND status = 'completed'", run.id, turnId);
      store.run('UPDATE sessions SET pending = 1, status = ?, error = NULL WHERE id = ?', 'running', session.id);
    }
  } else if (['Stop', 'StopFailure', 'Interrupt'].includes(event)) {
    if (!turnId || (session.active_turn && turnId !== session.active_turn)) { incident(store, run, 'HOOK_TURN_ID_MISMATCH'); return; }
    if (!session.active_turn) { closeOrphans(store, run, session, turnId, time); store.run('UPDATE sessions SET active_turn = ? WHERE id = ?', turnId, session.id); }
    // The turn's own request, plus messages steered into it. A Claude message typed after the turn's last tool result is
    // answered in a continuation turn instead, so it keeps running until that turn stops.
    // Only messages that arrived during this turn after its last tool result wait: a continuation turn answers those that
    // arrived before it began.
    const marks = store.get("SELECT MIN(time) AS start, MAX(CASE WHEN event_name IN ('PostToolUse','PostToolUseFailure') THEN time END) AS tool FROM events WHERE run_id = ? AND turn_id = ?", run.id, turnId);
    const since = [marks?.start, marks?.tool].filter(Boolean).sort().at(-1) || '';
    const steers = store.all("SELECT request_id, accepted_at FROM requests WHERE run_id = ? AND native_turn_id = ? AND transport = 'terminal-steer' AND status = 'running'", run.id, turnId);
    const waiting = session.provider === 'claude' && event === 'Stop' ? steers.filter(steer => steer.accepted_at > since) : [];
    const request = store.get("SELECT * FROM requests WHERE run_id = ? AND native_turn_id = ? AND transport != 'terminal-steer' ORDER BY created_at DESC LIMIT 1", run.id, turnId);
    const status = event === 'Stop' ? 'completed' : event === 'StopFailure' ? 'failed' : 'interrupted';
    const response = event === 'Stop' && typeof e.last_assistant_message === 'string' ? e.last_assistant_message : null;
    // Running background tasks keep the turn open; scheduled crons are future turns of their own.
    const background = event === 'Stop' && e.background_tasks?.length > 0;
    const failure = typeof e.error === 'string' ? e.error : e.error?.type;
    // The CLI is back at its prompt after an interrupt or a transient API error; the request keeps the outcome.
    const idle = event === 'Stop' || event === 'Interrupt' || TRANSIENT_FAILURES.has(failure);
    for (const target of [request, ...steers.filter(steer => !waiting.includes(steer))].filter(Boolean))
      store.run('UPDATE requests SET status = ?, response = ?, error = ?, completed_at = ? WHERE session_id = ? AND request_id = ?', background ? 'running' : status, response, event === 'StopFailure' ? JSON.stringify(e.error || 'StopFailure') : null, background ? null : time, session.id, target.request_id);
    if (waiting.length) {
      // The continuation turn for those messages comes next: the CLI is still busy.
      store.run('UPDATE sessions SET pending = 1, status = ?, error = NULL, last_response = COALESCE(?,last_response), last_response_at = CASE WHEN ? IS NULL THEN last_response_at ELSE ? END WHERE id = ?', 'running', response, response, time, session.id);
    } else {
      store.run('UPDATE sessions SET pending = ?, status = ?, error = ?, last_response = COALESCE(?,last_response), last_response_at = CASE WHEN ? IS NULL THEN last_response_at ELSE ? END WHERE id = ?', background ? 1 : 0, background ? 'running' : idle ? 'ready' : 'attention', idle ? null : event.toUpperCase(), response, response, time, session.id);
    }
  } else if (event === 'SessionStart') {
    // A compaction inside a turn Harbor lost track of does not prove the CLI is idle.
    if (!session.pending && !unknownTurn(store, run, session)) store.run('UPDATE sessions SET status = ?, error = NULL WHERE id = ?', 'ready', session.id);
  } else if (event === 'SessionEnd') {
    store.run("UPDATE requests SET status = 'interrupted', completed_at = ?, error = 'CLI_EXITED' WHERE run_id = ? AND status NOT IN ('completed','failed','interrupted')", time, run.id);
    store.run('UPDATE sessions SET pending = 0 WHERE id = ?', session.id);
  }
  const attention = store.runRecord(run.id).attention;
  if (attention) store.run('UPDATE sessions SET status = ?, error = ? WHERE id = ?', 'attention', attention, session.id);
}
