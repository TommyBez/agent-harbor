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
  if (event === 'UserPromptSubmit') {
    if (!turnId) { incident(store, run, 'HOOK_TURN_ID_MISSING'); return; }
    // A new Claude prompt while the previous turn never stopped (an Esc interrupt fires no hook) ends that turn's request.
    if (session.provider === 'claude' && session.pending && session.active_turn && session.active_turn !== turnId && !store.get("SELECT 1 FROM events WHERE run_id = ? AND turn_id = ? AND event_name IN ('Stop','StopFailure') LIMIT 1", run.id, session.active_turn))
      store.run("UPDATE requests SET status = 'interrupted', error = 'TURN_SUPERSEDED', completed_at = ? WHERE run_id = ? AND native_turn_id = ? AND status = 'running'", time, run.id, session.active_turn);
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
    if (request) store.run('UPDATE requests SET status = ?, accepted_at = ?, native_turn_id = ? WHERE session_id = ? AND request_id = ?', 'running', time, turnId, session.id, request.request_id);
    store.run('UPDATE sessions SET pending = 1, active_turn = ?, status = ?, error = NULL WHERE id = ?', turnId, 'running', session.id);
  } else if (event === 'Notification') {
    // Claude notifies only when its own dialog is actually waiting for the human, not when a hook or auto mode answered.
    const code = e.notification_type === 'permission_prompt' ? 'PERMISSION_REQUIRED' : ['elicitation_dialog', 'elicitation_url_dialog'].includes(e.notification_type) ? 'CLI_ATTENTION_REQUIRED' : null;
    if (code) store.run('UPDATE sessions SET status = ?, error = ? WHERE id = ?', 'attention', code, session.id);
  } else if (event === 'PermissionRequest') {
    // Approval routing started; a reviewer or another hook may answer it. Service.refresh raises attention only if the
    // CLI then stays silent (Codex), and Claude reports a waiting dialog through its permission_prompt Notification.
  } else if (['PostToolUse', 'PostToolUseFailure', 'PermissionDenied'].includes(event)) {
    if (turnId && turnId === session.active_turn && !run.attention) {
      store.run("UPDATE requests SET status = 'running', completed_at = NULL WHERE run_id = ? AND native_turn_id = ? AND status = 'completed'", run.id, turnId);
      store.run('UPDATE sessions SET pending = 1, status = ?, error = NULL WHERE id = ?', 'running', session.id);
    }
  } else if (['Stop', 'StopFailure', 'Interrupt'].includes(event)) {
    if (!turnId || (session.active_turn && turnId !== session.active_turn)) { incident(store, run, 'HOOK_TURN_ID_MISMATCH'); return; }
    const request = store.get('SELECT * FROM requests WHERE run_id = ? AND native_turn_id = ? ORDER BY created_at DESC LIMIT 1', run.id, turnId);
    const status = event === 'Stop' ? 'completed' : event === 'StopFailure' ? 'failed' : 'interrupted';
    const response = event === 'Stop' && typeof e.last_assistant_message === 'string' ? e.last_assistant_message : null;
    // Running background tasks keep the turn open; scheduled crons are future turns of their own.
    const background = event === 'Stop' && e.background_tasks?.length > 0;
    const failure = typeof e.error === 'string' ? e.error : e.error?.type;
    // The CLI is back at its prompt after an interrupt or a transient API error; the request keeps the outcome.
    const idle = event === 'Stop' || event === 'Interrupt' || TRANSIENT_FAILURES.has(failure);
    if (request) store.run('UPDATE requests SET status = ?, response = ?, error = ?, completed_at = ? WHERE session_id = ? AND request_id = ?', background ? 'running' : status, response, event === 'StopFailure' ? JSON.stringify(e.error || 'StopFailure') : null, background ? null : time, session.id, request.request_id);
    store.run('UPDATE sessions SET pending = ?, status = ?, error = ?, last_response = COALESCE(?,last_response), last_response_at = CASE WHEN ? IS NULL THEN last_response_at ELSE ? END WHERE id = ?', background ? 1 : 0, background ? 'running' : idle ? 'ready' : 'attention', idle ? null : event.toUpperCase(), response, response, time, session.id);
  } else if (event === 'SessionStart') {
    if (!session.pending) store.run('UPDATE sessions SET status = ?, error = NULL WHERE id = ?', 'ready', session.id);
  } else if (event === 'SessionEnd') {
    store.run("UPDATE requests SET status = 'interrupted', completed_at = ?, error = 'CLI_EXITED' WHERE run_id = ? AND status NOT IN ('completed','failed','interrupted')", time, run.id);
    store.run('UPDATE sessions SET pending = 0 WHERE id = ?', session.id);
  }
  const attention = store.runRecord(run.id).attention;
  if (attention) store.run('UPDATE sessions SET status = ?, error = ? WHERE id = ?', 'attention', attention, session.id);
}
