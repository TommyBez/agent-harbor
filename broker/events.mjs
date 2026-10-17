import fs from 'node:fs';
import path from 'node:path';
import { usesWorktree, sameRepository } from './arguments.mjs';
import { hashPrompt, now } from './common.mjs';

const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
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
  if (e.cwd && path.resolve(e.cwd) !== (session.working_directory || session.project)) {
    if (!session.working_directory && usesWorktree(session) && ['SessionStart','UserPromptSubmit'].includes(e.hook_event_name) && sameRepository(session.project, e.cwd)) {
      store.run('UPDATE sessions SET working_directory = ? WHERE id = ?', fs.realpathSync(e.cwd), session.id);
      session.working_directory = fs.realpathSync(e.cwd);
    } else { incident(store, run, 'HOOK_PROJECT_MISMATCH', { offset }); return; }
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
    const hash = typeof e.prompt === 'string' ? hashPrompt(e.prompt) : null;
    const request = hash ? store.get("SELECT * FROM requests WHERE run_id = ? AND prompt_hash = ? AND accepted_at IS NULL AND status IN ('intent','delivering','awaiting_ack','uncertain') ORDER BY created_at LIMIT 1", run.id, hash) : null;
    if (request) store.run('UPDATE requests SET status = ?, accepted_at = ?, native_turn_id = ? WHERE session_id = ? AND request_id = ?', 'running', time, turnId, session.id, request.request_id);
    store.run('UPDATE sessions SET pending = 1, active_turn = ?, status = ?, error = NULL WHERE id = ?', turnId, 'running', session.id);
  } else if (['PermissionRequest', 'Notification'].includes(event)) {
    const relevant = event === 'PermissionRequest' || ['permission_prompt', 'elicitation_dialog', 'auth_success'].includes(e.notification_type);
    if (relevant && e.notification_type !== 'auth_success') store.run('UPDATE sessions SET status = ?, error = ? WHERE id = ?', 'attention', event === 'PermissionRequest' ? 'PERMISSION_REQUIRED' : 'CLI_ATTENTION_REQUIRED', session.id);
  } else if (event === 'PostToolUse') {
    if (turnId && turnId === session.active_turn && !run.attention) {
      store.run("UPDATE requests SET status = 'running', completed_at = NULL WHERE run_id = ? AND native_turn_id = ? AND status = 'completed'", run.id, turnId);
      store.run('UPDATE sessions SET pending = 1, status = ?, error = NULL WHERE id = ?', 'running', session.id);
    }
  } else if (['Stop', 'StopFailure', 'Interrupt'].includes(event)) {
    if (!turnId || (session.active_turn && turnId !== session.active_turn)) { incident(store, run, 'HOOK_TURN_ID_MISMATCH'); return; }
    const request = store.get('SELECT * FROM requests WHERE run_id = ? AND native_turn_id = ? ORDER BY created_at DESC LIMIT 1', run.id, turnId);
    const status = event === 'Stop' ? 'completed' : event === 'StopFailure' ? 'failed' : 'interrupted';
    const response = event === 'Stop' && typeof e.last_assistant_message === 'string' ? e.last_assistant_message : null;
    const background = event === 'Stop' && (e.background_tasks?.length > 0 || e.session_crons?.length > 0);
    if (request) store.run('UPDATE requests SET status = ?, response = ?, error = ?, completed_at = ? WHERE session_id = ? AND request_id = ?', background ? 'running' : status, response, event === 'StopFailure' ? JSON.stringify(e.error || 'StopFailure') : null, background ? null : time, session.id, request.request_id);
    store.run('UPDATE sessions SET pending = ?, status = ?, error = ?, last_response = COALESCE(?,last_response), last_response_at = CASE WHEN ? IS NULL THEN last_response_at ELSE ? END WHERE id = ?', background ? 1 : 0, background ? 'running' : event === 'Stop' ? 'ready' : 'attention', event === 'Stop' ? null : event.toUpperCase(), response, response, time, session.id);
  } else if (event === 'SessionStart') {
    if (!session.pending) store.run('UPDATE sessions SET status = ?, error = NULL WHERE id = ?', 'ready', session.id);
  } else if (event === 'SessionEnd') {
    store.run("UPDATE requests SET status = 'interrupted', completed_at = ?, error = 'CLI_EXITED' WHERE run_id = ? AND status NOT IN ('completed','failed','interrupted')", time, run.id);
    store.run('UPDATE sessions SET pending = 0 WHERE id = ?', session.id);
  }
  const attention = store.runRecord(run.id).attention;
  if (attention) store.run('UPDATE sessions SET status = ?, error = ? WHERE id = ?', 'attention', attention, session.id);
}
