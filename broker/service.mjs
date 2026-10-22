import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { now, fail, hashPrompt, validateText, validateActor, executable, CLI, VERSION } from './common.mjs';
import { importEvents } from './events.mjs';
import { validateCliArgs, usesWorktree } from './arguments.mjs';
import { launchCommand, trustHelperCommand } from './providers.mjs';
import { trustPrompt, autoTrustRoot, parentSuggestion, updateTrustedFolders, trustedFolders, folderInside, WORKTREE_TRUST_ERROR, UPDATE_NOTICE } from './trust.mjs';
import { readImages, stageImages, imagePrompt, imagePayloadHash } from './images.mjs';

const FINISHED = new Set(['completed', 'failed', 'interrupted']);
const TRUST_ERRORS = new Set(['TRUST_REQUIRED', 'HOOK_TRUST_REQUIRED']);
// A Codex PermissionRequest may be answered by its reviewer or another hook; ask the human only if nothing follows.
const PERMISSION_GRACE = 6000;
const BOOTSTRAP = 'Initialize this interactive session. Reply only READY. Do not use tools or modify files.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_MENTION = /\[Image #\d+\]|@"(?:[^"\\\n]|\\.)*\.(?:png|jpe?g|webp|gif)"|(?<=^|\s)@[^\s"]+\.(?:png|jpe?g|webp|gif)(?=\s|$)/gi;
/** A session name from its first task: the first meaningful line without image mentions, at most 60 characters cut at a word.
 * Names only; the delivered prompt and its hash never change. The desktop form previews the same rules (taskTitle in app/src/main.zig). */
export function taskTitle(text) {
  if (typeof text !== 'string') return '';
  const line = text.replace(IMAGE_MENTION, ' ').split(/\r\n|\r|\n/)
    .map(value => value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/^ *(?:[#>*+-]+ +)+/, '').replace(/ +/g, ' ').replace(/^ | $/g, ''))
    .find(value => /[A-Za-z0-9]|[^\x00-\x7f]/.test(value));
  if (!line) return '';
  const characters = Array.from(line);
  if (characters.length <= 60) return line;
  const head = characters.slice(0, 59).join('');
  // The cut lands on a word boundary: after the last whole word that fits, leaving room for the ellipsis.
  const space = characters[59] === ' ' ? head.length : head.lastIndexOf(' ');
  return (space > 0 ? head.slice(0, space) : head).replace(/[ ,;:.-]+$/, '') + '…';
}
export class Service {
  constructor(config, store, tmux) { this.config = config; this.store = store; this.tmux = tmux; this.panes = new Map(); this.queues = new Map(); this.keys = new Map(); this.trustSeen = new Map(); this.dialogSince = new Map(); }
  refresh() {
    this.panes = this.tmux.panes();
    for (const session of this.store.all('SELECT * FROM sessions WHERE run_id IS NOT NULL AND archived_at IS NULL')) {
      let run = this.store.runRecord(session.run_id);
      if (run.purpose === 'trust') { this.trustHelper(session, run); continue; }
      importEvents(this.store, this.config, run);
      run = this.store.runRecord(session.run_id);
      const pane = this.livePane(run);
      if (pane) {
        if (run.pid !== pane.pid || run.pane_id !== pane.id) { this.store.run('UPDATE runs SET pid = ?, pane_id = ? WHERE id = ?', pane.pid, pane.id, run.id); run = this.store.runRecord(run.id); }
        if (run.attention) { this.store.run("UPDATE sessions SET status = 'attention', error = ? WHERE id = ?", run.attention, session.id); }
        const trustOpen = !run.hooks_ready && this.answerStartup(this.store.session(session.id), run);
        const current = this.store.session(session.id);
        // Time spent in the trust dialog does not count against CLI startup.
        const since = time => Date.now() - Math.max(Date.parse(time), this.trustSeen.get(run.id) || 0);
        if (trustOpen) {
          // The CLI is waiting on its workspace-trust dialog: answered automatically or by the human.
        } else if (!run.hooks_ready && since(run.started_at) > this.config.startupTimeout) {
          this.store.run("UPDATE sessions SET status = 'attention', error = 'HOOKS_NOT_READY' WHERE id = ?", session.id);
        } else {
          const delivery = this.store.get("SELECT status, created_at, delivered_at FROM requests WHERE run_id = ? AND status IN ('intent','delivering','awaiting_ack','uncertain') ORDER BY created_at DESC LIMIT 1", run.id);
          // Age counts from this run's delivery: a request moved to a relaunch keeps its original created_at.
          const sent = delivery && new Date(Math.max(Date.parse(delivery.delivered_at || delivery.created_at), Date.parse(run.started_at))).toISOString();
          if (delivery && since(sent) > this.config.startupTimeout && current.status !== 'attention') this.store.run("UPDATE sessions SET status = 'attention', error = ? WHERE id = ?", delivery.status === 'uncertain' ? 'DELIVERY_UNCERTAIN' : 'PROMPT_NOT_ACKNOWLEDGED', session.id);
          if (session.provider === 'codex' && current.pending && current.status !== 'attention') {
            const last = this.store.get('SELECT event_name, time FROM events WHERE run_id = ? ORDER BY seq DESC LIMIT 1', run.id);
            if (last?.event_name === 'PermissionRequest' && Date.now() - Date.parse(last.time) > PERMISSION_GRACE) this.store.run("UPDATE sessions SET status = 'attention', error = 'PERMISSION_REQUIRED' WHERE id = ?", session.id);
          }
        }

      } else if (!run.ended_at) {
        if (this.openTrustHelper(session, run)) continue;
        this.forgetLaunch(run.id);
        if (run.trust === 'required' && !run.hooks_ready) { this.trustDeclined(session, [run.id]); continue; }
        const time = now();
        this.store.transaction(() => {
          this.store.run('UPDATE runs SET ended_at = ? WHERE id = ?', time, run.id);
          this.store.run("UPDATE requests SET status = 'interrupted', error = 'PROCESS_EXITED', completed_at = ? WHERE run_id = ? AND status NOT IN ('completed','failed','interrupted')", time, run.id);
          this.store.run("UPDATE sessions SET status = 'stopped', pending = 0, closing = 0, updated_at = ? WHERE id = ?", time, session.id);
          this.store.audit('process_exited', session.id, { runId: run.id, pid: run.pid });
        });
      }
    }
    // The trust helper holds no conversation; its terminal stays writable for the human.
    this.tmux.syncOwnership(this.store.all('SELECT id,owner,run_id FROM sessions WHERE run_id IS NOT NULL AND archived_at IS NULL').map(s => { const run = this.store.runRecord(s.run_id); return { ...s, owner: run.purpose === 'trust' ? 'human' : s.owner, tmuxName: run.tmux_name }; }));
  }
  // Releases up to 0.1.3 raised a sticky HOOK_PROJECT_MISMATCH whenever Claude's shell left the project root, dropped every
  // event from that folder, and a dropped Stop or prompt could then cascade into HOOK_TURN_ID_MISMATCH. Under the current
  // rules a Claude cwd incident only precedes the run's first accepted event, so one that follows an accepted event is
  // legacy. Recovery clears it so the CLI's next events count again. It never replays or guesses: a live run is 'ready'
  // only when its last accepted event is a plain Stop with nothing dropped after it; otherwise it asks the human to check
  // (TURN_STATE_UNKNOWN) until the CLI's next event sets the real state. Once per run.
  recoverCwdIncidents() {
    for (const run of this.store.all("SELECT r.* FROM runs r JOIN sessions s ON s.id = r.session_id WHERE r.attention IN ('HOOK_PROJECT_MISMATCH','HOOK_TURN_ID_MISMATCH') AND s.provider = 'claude'")) {
      const audits = this.store.all("SELECT seq, action, details FROM audit WHERE session_id = ? AND action IN ('HOOK_PROJECT_MISMATCH','HOOK_TURN_ID_MISMATCH','cwd_incident_cleared') ORDER BY seq", run.session_id)
        .map(row => { try { return { ...JSON.parse(row.details), seq: row.seq, action: row.action }; } catch { return null; } }).filter(audit => audit?.runId === run.id);
      if (audits.some(audit => audit.action === 'cwd_incident_cleared')) continue;
      const cwd = audits.find(audit => audit.action === 'HOOK_PROJECT_MISMATCH' && Number.isInteger(audit.offset));
      if (!cwd || !this.store.get('SELECT 1 FROM events WHERE run_id = ? AND source_offset < ? LIMIT 1', run.id, cwd.offset)) continue;
      if (run.attention === 'HOOK_TURN_ID_MISMATCH' && !audits.some(audit => audit.action === 'HOOK_TURN_ID_MISMATCH' && audit.seq > cwd.seq)) continue;
      const idle = !run.ended_at && this.legacyIdle(run);
      this.store.transaction(() => {
        this.store.run('UPDATE runs SET attention = NULL WHERE id = ?', run.id);
        if (run.ended_at) this.store.run('UPDATE sessions SET error = NULL WHERE run_id = ? AND error = ?', run.id, run.attention);
        else if (idle) this.store.run("UPDATE sessions SET status = 'ready', error = NULL WHERE run_id = ?", run.id);
        else {
          // Forget the turn the legacy rule may have lost track of: the CLI's next event sets it. An open request keeps
          // running (its own Stop can still arrive) but is marked so it is never reported as a human interruption.
          this.store.run("UPDATE sessions SET status = 'attention', error = 'TURN_STATE_UNKNOWN', active_turn = NULL WHERE run_id = ?", run.id);
          this.store.run("UPDATE requests SET error = 'RESULT_NOT_OBSERVED' WHERE run_id = ? AND status = 'running'", run.id);
        }
        this.store.audit('cwd_incident_cleared', run.session_id, { runId: run.id, state: run.ended_at ? 'ended' : idle ? 'ready' : 'unknown' });
      });
    }
  }
  // The run's last accepted event, ignoring informational notifications, is a Stop without background work, no turn is open,
  // and the journal holds nothing after the last accepted line (a later line would have been dropped by the legacy rule).
  legacyIdle(run) {
    const session = this.store.get('SELECT pending FROM sessions WHERE run_id = ?', run.id);
    const last = this.store.get('SELECT source_offset FROM events WHERE run_id = ? ORDER BY source_offset DESC LIMIT 1', run.id);
    const relevant = this.store.get("SELECT event_name, payload FROM events WHERE run_id = ? AND NOT (event_name = 'Notification' AND COALESCE(json_extract(payload, '$.notification_type'), '') NOT IN ('permission_prompt','elicitation_dialog','elicitation_url_dialog')) ORDER BY source_offset DESC LIMIT 1", run.id);
    if (!session || session.pending || !last || relevant?.event_name !== 'Stop' || (JSON.parse(relevant.payload).background_tasks || []).length) return false;
    try {
      const journal = fs.readFileSync(path.join(this.config.home, 'runs', run.id, 'events.jsonl'));
      const end = journal.indexOf(10, last.source_offset);
      return end >= 0 && journal.subarray(end + 1).toString('utf8').trim() === '';
    } catch { return false; }
  }
  // Startup dialogs shown before Harbor's observation begins. Returns true while the trust dialog is open.
  answerStartup(session, run) {
    const target = this.terminal(run);
    if (!target) return false;
    let screen;
    try { screen = this.tmux.screen(target); } catch { return false; }
    const prompt = trustPrompt(session.provider, screen);
    if (!prompt) {
      this.dialogSince.delete(run.id);
      if (TRUST_ERRORS.has(session.error)) this.store.run("UPDATE sessions SET status = 'starting', error = NULL, updated_at = ? WHERE id = ? AND error IN ('TRUST_REQUIRED','HOOK_TRUST_REQUIRED')", now(), session.id);
      // Codex's update notice blocks a bot-started CLI. Skip it for this launch; never install.
      if (session.provider === 'codex' && session.owner === 'grok' && UPDATE_NOTICE.test(screen) && this.keystroke(target, 'update', 'Escape')) this.store.audit('update_notice_skipped', session.id, { runId: run.id });
      return false;
    }
    this.trustSeen.set(run.id, Date.now());
    if (!this.dialogSince.has(run.id)) this.dialogSince.set(run.id, Date.now());
    const directory = session.working_directory || session.project;
    // A folder dialog names its folder; Codex's hook review concerns the launch directory.
    const folder = prompt.kind === 'folder' ? prompt.folder : directory;
    if (prompt.kind === 'folder' && (!run.trust || run.trust_folder !== folder)) this.store.run("UPDATE runs SET trust = COALESCE(trust, 'required'), trust_folder = ? WHERE id = ?", folder, run.id);
    const root = autoTrustRoot(this.config, folder, directory);
    if (root) {
      // A dialog can render before the CLI reads input; keys sent too early are lost.
      const settled = this.dialogSettled(run);
      if (settled && prompt.selected === 'accept' && this.keystroke(target, 'accept:' + prompt.kind, 'Enter')) {
        if (prompt.kind === 'folder') this.store.run("UPDATE runs SET trust = 'accepted' WHERE id = ?", run.id);
        this.store.audit('trust_auto_accepted', session.id, { runId: run.id, kind: prompt.kind, folder, trustedFolder: root });
      } else if (settled && prompt.selected !== 'accept' && prompt.navigate) this.keystroke(target, 'select:' + prompt.kind, 'Down');
      const sent = this.keys.get(run.id);
      if (!settled || (sent?.last && Date.now() - sent.last < 3000)) {
        // Harbor is answering: an earlier startup warning no longer applies.
        if (session.status === 'attention' && ['TRUST_REQUIRED', 'HOOK_TRUST_REQUIRED', 'HOOKS_NOT_READY', 'PROMPT_NOT_ACKNOWLEDGED'].includes(session.error)) this.store.run("UPDATE sessions SET status = 'starting', error = NULL, updated_at = ? WHERE id = ?", now(), session.id);
        return true; // Let the dialog react before asking the human.
      }
    }
    const error = prompt.kind === 'hooks' ? 'HOOK_TRUST_REQUIRED' : 'TRUST_REQUIRED';
    if (session.status !== 'attention' || session.error !== error) this.store.run("UPDATE sessions SET status = 'attention', error = ?, updated_at = ? WHERE id = ?", error, now(), session.id);
    return true;
  }
  dialogSettled(run) { return Date.now() - (this.dialogSince.get(run.id) ?? Date.now()) >= 1500; }
  // At most one keystroke of each kind per run, spaced so the dialog can redraw before the next one.
  keystroke(run, kind, key) {
    const sent = this.keys.get(run.id) || {};
    if (sent[kind] || Date.now() - (sent.last || 0) < 700) return false;
    this.tmux.key(run, key);
    this.keys.set(run.id, { ...sent, [kind]: Date.now(), last: Date.now() });
    return true;
  }
  // Claude refuses --worktree before workspace trust and exits. Show its own trust dialog in a helper, then repeat the launch.
  openTrustHelper(session, run) {
    const launchFile = path.join(this.config.home, 'runs', run.id, 'launch.json');
    if (session.provider !== 'claude' || run.hooks_ready || session.working_directory || !usesWorktree(session) || !fs.existsSync(launchFile)) return false;
    const target = this.terminal(run, { read: true });
    let screen = '';
    try { if (target) screen = this.tmux.capture(target); } catch {}
    if (!WORKTREE_TRUST_ERROR.test(screen)) return false;
    if (!this.store.get("SELECT 1 FROM requests WHERE run_id = ? AND accepted_at IS NULL AND status = 'awaiting_ack'", run.id)) return false;
    const helper = { id: randomUUID(), started_at: now() };
    helper.tmux_name = 'harbor-' + helper.id;
    fs.mkdirSync(path.join(this.config.home, 'runs', helper.id), { mode: 0o700 });
    fs.writeFileSync(path.join(this.config.home, 'runs', helper.id, 'launch.json'), JSON.stringify({ origin: run.id, command: JSON.parse(fs.readFileSync(launchFile, 'utf8')) }), { mode: 0o600 });
    fs.rmSync(launchFile, { force: true });
    this.store.transaction(() => {
      this.store.run("INSERT INTO runs(id,session_id,tmux_name,started_at,purpose) VALUES(?,?,?,?,'trust')", helper.id, session.id, helper.tmux_name, helper.started_at);
      this.store.run('UPDATE runs SET ended_at = ? WHERE id = ?', helper.started_at, run.id);
      this.store.run("UPDATE sessions SET run_id = ?, status = 'starting', error = NULL, updated_at = ? WHERE id = ?", helper.id, helper.started_at, session.id);
      this.store.audit('trust_helper_started', session.id, { runId: run.id, helperRunId: helper.id });
    });
    try {
      const launched = this.tmux.launch(helper, session, trustHelperCommand(this.config));
      this.store.run('UPDATE runs SET pane_id = ?, pid = ? WHERE id = ?', launched.paneId, launched.pid, helper.id);
    } catch (error) {
      this.store.audit('trust_helper_failed', session.id, { helperRunId: helper.id, error: error.message });
      this.forgetLaunch(helper.id);
      this.trustDeclined(session, [helper.id, run.id], 'TRUST_HELPER_FAILED');
    }
    return true;
  }
  trustHelper(session, run) {
    const pane = this.livePane(run);
    if (pane && (run.pid !== pane.pid || run.pane_id !== pane.id)) { this.store.run('UPDATE runs SET pid = ?, pane_id = ? WHERE id = ?', pane.pid, pane.id, run.id); run = this.store.runRecord(run.id); }
    if (!run.hooks_ready && this.helperStarted(session, run)) { this.store.run('UPDATE runs SET hooks_ready = 1 WHERE id = ?', run.id); run = this.store.runRecord(run.id); }
    if (pane) {
      if (!run.hooks_ready) {
        const open = this.answerStartup(this.store.session(session.id), run);
        // Claude leaves its trust dialog only by trusting the folder ("No" exits), so a dialog seen earlier that is
        // gone while the CLI runs means trust was recorded, even if a hook fails to report SessionStart.
        if (!open && run.trust && Date.now() - (this.trustSeen.get(run.id) || 0) > 3000) {
          this.store.run('UPDATE runs SET hooks_ready = 1 WHERE id = ?', run.id);
          this.store.audit('trust_helper_dialog_closed', session.id, { helperRunId: run.id });
          return; // The next refresh ends the helper.
        }
        if (!open && Date.now() - Math.max(Date.parse(run.started_at), this.trustSeen.get(run.id) || 0) > this.config.startupTimeout) this.store.run("UPDATE sessions SET status = 'attention', error = 'HOOKS_NOT_READY' WHERE id = ? AND (error IS NULL OR error != 'HOOKS_NOT_READY')", session.id);
      } else if (!this.keys.get(run.id)?.end) {
        // Trust is recorded once the CLI starts. The helper holds no conversation, so ending it loses nothing.
        try { process.kill(pane.pid, 'SIGTERM'); } catch {}
        this.keys.set(run.id, { ...this.keys.get(run.id), end: Date.now() });
      } else if (Date.now() - this.keys.get(run.id).end > 15000) {
        // Never force-killed: the human sees what keeps the helper open.
        this.store.run("UPDATE sessions SET status = 'attention', error = 'CLI_ATTENTION_REQUIRED' WHERE id = ? AND (error IS NULL OR error != 'CLI_ATTENTION_REQUIRED')", session.id);
      }
      return;
    }
    if (run.ended_at) return;
    const launchFile = path.join(this.config.home, 'runs', run.id, 'launch.json');
    let launch = null;
    try { launch = JSON.parse(fs.readFileSync(launchFile, 'utf8')); } catch {}
    fs.rmSync(launchFile, { force: true });
    this.store.run('UPDATE runs SET ended_at = ? WHERE id = ?', now(), run.id);
    if (!run.hooks_ready || !launch) { this.trustDeclined(session, [run.id, launch?.origin].filter(Boolean)); return; }
    const next = { id: randomUUID(), started_at: now() };
    next.tmux_name = 'harbor-' + next.id;
    fs.mkdirSync(path.join(this.config.home, 'runs', next.id), { mode: 0o700 });
    this.store.transaction(() => {
      this.store.run('INSERT INTO runs(id,session_id,tmux_name,started_at) VALUES(?,?,?,?)', next.id, session.id, next.tmux_name, next.started_at);
      this.store.run("UPDATE requests SET run_id = ?, delivered_at = ? WHERE session_id = ? AND run_id = ? AND accepted_at IS NULL AND status = 'awaiting_ack'", next.id, next.started_at, session.id, launch.origin);
      this.store.run("UPDATE sessions SET run_id = ?, status = 'starting', error = NULL, updated_at = ? WHERE id = ?", next.id, next.started_at, session.id);
      this.store.audit('trust_relaunch', session.id, { helperRunId: run.id, runId: next.id });
    });
    try {
      const launched = this.tmux.launch(next, session, launch.command);
      this.store.run('UPDATE runs SET pane_id = ?, pid = ? WHERE id = ?', launched.paneId, launched.pid, next.id);
    } catch (error) {
      this.store.run("UPDATE requests SET status = 'uncertain', error = ? WHERE session_id = ? AND run_id = ? AND accepted_at IS NULL", error.message, session.id, next.id);
      this.store.run("UPDATE sessions SET status = 'attention', error = 'DELIVERY_UNCERTAIN' WHERE id = ?", session.id);
    }
  }
  helperStarted(session, run) {
    try {
      return fs.readFileSync(path.join(this.config.home, 'runs', run.id, 'events.jsonl'), 'utf8').split('\n').some(line => {
        try { const entry = JSON.parse(line); return entry.sessionId === session.id && entry.runId === run.id && entry.event?.hook_event_name === 'SessionStart'; } catch { return false; }
      });
    } catch { return false; }
  }
  // The CLI exited from its trust dialog without trusting the folder: no conversation was created, so the session can start fresh.
  trustDeclined(session, runIds, code = 'TRUST_DECLINED') {
    const time = now();
    this.store.transaction(() => {
      for (const runId of runIds) {
        this.store.run('UPDATE runs SET ended_at = COALESCE(ended_at, ?) WHERE id = ?', time, runId);
        this.store.run("UPDATE requests SET status = 'interrupted', error = ?, completed_at = ? WHERE run_id = ? AND status NOT IN ('completed','failed','interrupted')", code, time, runId);
      }
      this.store.run("UPDATE sessions SET run_id = NULL, native_id = NULL, status = 'stopped', error = ?, pending = 0, closing = 0, active_turn = NULL, updated_at = ? WHERE id = ?", code, time, session.id);
      this.store.audit(code === 'TRUST_DECLINED' ? 'trust_declined' : 'trust_helper_abandoned', session.id, { runIds, code });
    });
  }
  forgetLaunch(runId) { fs.rmSync(path.join(this.config.home, 'runs', runId, 'launch.json'), { force: true }); }
  // tmux pane IDs are unique only while one tmux server runs: after it restarts they begin again at %0, so a
  // stored ID can name another session's pane. A pane counts for a run only inside the run's own tmux session.
  pane(run) {
    if (!run) return null;
    if (/^%\d+$/.test(run.pane_id || '')) { const pane = this.panes.get(run.pane_id); return pane?.name === run.tmux_name ? pane : null; }
    // A pane ID recorded under a non-UTF-8 locale may carry tmux's escaped separator; recover from the primary pane.
    // refresh() then records the recovered ID for a live run.
    return [...this.panes.values()].find(p => p.name === run.tmux_name && p.windowIndex === 0 && p.paneIndex === 0) || null;
  }
  // An ended run stays ended, whatever now runs in tmux.
  livePane(run) { const pane = this.pane(run); return pane?.alive && !run.ended_at ? pane : null; }
  // The only way input and capture reach tmux: the run with its checked pane. Input needs a live run; reading may
  // also use the run's own dead pane, such as an ended run's final screen.
  terminal(run, { read = false } = {}) { const pane = read ? this.pane(run) : this.livePane(run); return pane ? { ...run, pane_id: pane.id } : null; }
  describe(id, compact = false) {
    const s = this.store.session(id);
    const run = this.store.runRecord(s.run_id);
    const pane = this.livePane(run);
    const result = { id: s.id, title: s.title, provider: s.provider, project: s.project, workingDirectory: s.working_directory || s.project, owner: s.owner, alive: !!pane,
      status: s.status, nativeSessionId: s.native_id, pending: !!s.pending, closing: !!s.closing, error: s.error,
      createdAt: s.created_at, updatedAt: s.updated_at, archivedAt: s.archived_at, runId: s.run_id, pid: pane?.pid || run?.pid || null };
    result.trustFolder = s.error === 'TRUST_REQUIRED' ? run?.trust_folder || s.working_directory || s.project : s.error === 'HOOK_TRUST_REQUIRED' ? s.working_directory || s.project : null;
    result.trustParent = result.trustFolder ? parentSuggestion(result.trustFolder) : null;
    if (!compact) Object.assign(result, { cliArgs: JSON.parse(s.cli_args || '[]'), titleSource: s.title_source, hooksReady: !!run?.hooks_ready, lastResponse: s.last_response, lastResponseAt: s.last_response_at,
      attachCommand: process.execPath, attachArgs: [CLI, 'attach', id], terminal: run ? { command: this.tmux.binary, args: this.tmux.args(run, s.owner !== 'human' && run.purpose !== 'trust') } : null });
    return result;
  }
  request(id, requestId) {
    const r = requestId ? this.store.request(id, requestId) : this.store.get('SELECT * FROM requests WHERE session_id = ? ORDER BY created_at DESC LIMIT 1', id);
    if (!r && requestId) fail('REQUEST_NOT_FOUND', 'Request not found.');
    return r ? { requestId: r.request_id, sessionId: r.session_id, runId: r.run_id, status: r.status, actor: r.actor,
      accepted: !!r.accepted_at, nativeTurnId: r.native_turn_id, response: r.response, error: r.error,
      createdAt: r.created_at, acceptedAt: r.accepted_at, completedAt: r.completed_at, transport: r.transport, images: JSON.parse(r.images_json || '[]') } : null;
  }
  response(id, requestId, extra = {}) { return { ok: true, session: this.describe(id), ...(requestId ? { request: this.request(id, requestId) } : {}), ...extra }; }
  async execute(action, args = {}) {
    if (args.images !== undefined && !['create','start','resume','send'].includes(action)) fail('INVALID_IMAGES', 'Images are supported by create, start, resume and send only.');
    if (['watch', 'list', 'result', 'cli-args', 'capture', 'doctor', 'attach-info', 'wait', 'events'].includes(action)) return this.read(action, args);
    if (action === 'control') return this.mutate(action, args);
    if (action === 'trusted-folders') return this.trustedFolders(args);
    const key = args.id || 'create';
    const prior = this.queues.get(key) || Promise.resolve();
    const task = prior.catch(() => {}).then(() => this.mutate(action, args));
    this.queues.set(key, task);
    try { return await task; } finally { if (this.queues.get(key) === task) this.queues.delete(key); }
  }
  async read(action, args) {
    this.refresh();
    if (action === 'list' || action === 'watch') return { ok: true, sessions: this.store.all(`SELECT id FROM sessions ${args.archived ? '' : 'WHERE archived_at IS NULL'} ORDER BY created_at DESC`).map(s => this.describe(s.id, !!args.compact)) };
    if (action === 'doctor') {
      const dependencies = {};
      for (const name of ['tmux', 'codex', 'claude']) { try { dependencies[name] = { available: true, path: executable(name, this.config) }; } catch (error) { dependencies[name] = { available: false, error: error.message }; } }
      return { ok: true, version: VERSION, node: process.version, daemonPid: process.pid, home: this.config.home, database: this.config.database, socket: this.config.socket, schemaVersion: 6, capabilities: { requestImages: 1 }, dependencies };
    }
    const session = this.describe(args.id);
    if (action === 'events') {
      const after = Number(args.after || 0);
      if (!Number.isInteger(after) || after < 0) fail('INVALID_CURSOR', 'Event cursor must be a nonnegative integer.');
      const events = []; let bytes = 0;
      for (const row of this.store.iterate('SELECT e.* FROM events e JOIN runs r ON r.id = e.run_id WHERE r.session_id = ? AND e.seq > ? ORDER BY e.seq LIMIT 200', args.id, after)) {
        const event = { seq: row.seq, runId: row.run_id, time: row.time, event: JSON.parse(row.payload) };
        const size = Buffer.byteLength(JSON.stringify(event));
        if (events.length && bytes + size > 4 * 1024 * 1024) break;
        events.push(event); bytes += size;
      }
      return { ok: true, events, nextCursor: events.at(-1)?.seq || after };
    }
    if (action === 'result') return { ok: true, session, request: this.request(args.id, args.requestId) };
    // Only what "New session like this" reuses: bounded by the startup-argument limit, unlike a full result with responses.
    if (action === 'cli-args') return { ok: true, session: { id: session.id, provider: session.provider, project: session.project, cliArgs: session.cliArgs } };
    if (action === 'capture') { const target = this.terminal(this.store.runRecord(session.runId), { read: true }); return { ok: true, session, screen: target ? this.tmux.capture(target) : '' }; }
    if (action === 'attach-info') { if (!session.alive) fail('SESSION_STOPPED', 'Start the session before attaching.'); return { ok: true, session, command: this.tmux.binary, args: this.tmux.args(this.store.runRecord(session.runId), true) }; }
    if (action === 'wait') {
      const timeout = Number(args.timeout ?? 120000);
      if (!Number.isFinite(timeout) || timeout < 0 || timeout > 3600000) fail('INVALID_TIMEOUT', 'Timeout must be between 0 and 3,600,000 milliseconds.');
      if (!args.requestId) fail('REQUEST_ID_REQUIRED', 'wait requires --request-id.');
      const deadline = Date.now() + timeout;
      for (;;) {
        this.refresh();
        const current = this.describe(args.id);
        const request = this.request(args.id, args.requestId);
        const settled = request.status !== 'completed' || Date.now() - Date.parse(request.completedAt) >= 750;
        // --through-attention keeps waiting while a human answers the CLI, after the bot has told them.
        const attention = current.status === 'attention' && !args.throughAttention;
        const outcome = attention && request.status === 'completed' ? 'attention' : FINISHED.has(request.status) && settled ? request.status : attention ? 'attention' : Date.now() >= deadline ? 'timeout' : null;
        if (outcome) return { ok: true, outcome, session: current, request };
        await delay(Math.min(200, Math.max(1, deadline - Date.now())));
      }
    }
    fail('UNKNOWN_COMMAND', 'Unknown command.');
  }
  authorize(session, actor) { validateActor(actor); if (session.owner !== actor) fail('CONTROL_DENIED', `The session is controlled by ${session.owner}.`); if (session.archived_at) fail('SESSION_ARCHIVED', 'Archived sessions cannot be started or changed.'); }
  duplicate(session, requestId, payloadHash) {
    const existing = this.store.request(session.id, requestId);
    if (!existing) return false;
    if (existing.payload_hash !== payloadHash) fail('REQUEST_ID_CONFLICT', 'This request ID was already used with different text or images.');
    return true;
  }
  newRequest(session, run, requestId, prompt, actor, transport, payloadHash, images = []) {
    if (!requestId || typeof requestId !== 'string' || requestId.length > 200 || /[\x00-\x1f]/.test(requestId)) fail('INVALID_REQUEST_ID', 'Request ID must contain 1–200 printable characters.');
    this.store.run('INSERT INTO requests(session_id,request_id,run_id,prompt_hash,payload_hash,status,actor,created_at,transport,images_json) VALUES(?,?,?,?,?,?,?,?,?,?)', session.id, requestId, run.id, hashPrompt(prompt), payloadHash, 'intent', actor, now(), transport, JSON.stringify(images));
  }
  async mutate(action, args) {
    this.refresh();
    if (action === 'create') return this.create(args);
    let s = this.store.session(args.id);
    if (action === 'rename') { const title = this.title(args.title); this.store.run("UPDATE sessions SET title = ?, title_source = 'user', updated_at = ? WHERE id = ?", title, now(), s.id); return this.response(s.id); }
    if (action === 'control') {
      validateActor(args.owner);
      const actor = validateActor(args.actor || 'human');
      if (s.owner === 'human' && args.owner === 'grok' && actor !== 'human') fail('CONTROL_DENIED', 'Only the human can return their session to Grok.');
      if (s.archived_at) fail('SESSION_ARCHIVED', 'Archived session cannot change ownership.');
      if (s.owner === 'human' && args.owner === 'grok' && (s.pending || s.closing)) fail('TURN_PENDING', 'Let the human turn finish before returning control to Grok.');
      const run = this.store.runRecord(s.run_id);
      if (run && run.purpose !== 'trust' && this.livePane(run)) this.tmux.enforce(run, args.owner);
      this.store.run('UPDATE sessions SET owner = ?, control_epoch = control_epoch + 1, updated_at = ? WHERE id = ?', args.owner, now(), s.id);
      this.store.audit('control_changed', s.id, { from: s.owner, to: args.owner });
      return this.response(s.id);
    }
    if (action === 'restore') {
      this.store.run("UPDATE sessions SET archived_at = NULL, status = 'stopped', updated_at = ? WHERE id = ? AND archived_at IS NOT NULL", now(), s.id);
      this.store.audit('restored', s.id);
      return this.response(s.id);
    }
    if (action === 'archive') {
      if (this.describe(s.id).alive) fail('SESSION_ALIVE', 'Close the CLI before archiving.');
      this.store.run("UPDATE sessions SET archived_at = ?, status = 'archived', updated_at = ? WHERE id = ?", now(), now(), s.id);
      this.store.audit('archived', s.id);
      return this.response(s.id);
    }
    if (action === 'trust') return this.trust(s, args);
    const actor = args.actor || 'human';
    this.authorize(s, actor);
    if (action === 'start' || action === 'resume') return this.start(s, { ...args, action }, actor);
    if (action === 'send') {
      const inputImages = readImages(args.images);
      const text = validateText(args.text ?? (inputImages.length ? 'Describe the attached images.' : undefined));
      const payloadHash = imagePayloadHash(text, inputImages);
      const requestId = args.requestId || randomUUID();
      if (this.duplicate(s, requestId, payloadHash)) return this.response(s.id, requestId, { duplicate: true });
      this.canSend(s);
      const run = this.store.runRecord(s.run_id);
      const target = this.terminal(run) || fail('SESSION_STOPPED', 'Start the CLI before sending.');
      const images = stageImages(this.config, inputImages);
      const prompt = imagePrompt(s.provider, text, images);
      this.store.transaction(() => { this.newRequest(s, run, requestId, prompt, actor, images.length ? 'terminal-images' : 'terminal-paste', payloadHash, images); this.store.run("UPDATE sessions SET pending = 1, status = 'running', updated_at = ? WHERE id = ?", now(), s.id); this.store.audit('send_intent', s.id, { requestId, runId: run.id }); });
      try {
        this.store.run("UPDATE requests SET status = 'delivering' WHERE session_id = ? AND request_id = ?", s.id, requestId);
        const checkControl = () => {
          const current = this.store.session(s.id);
          this.authorize(current, actor);
          if (current.control_epoch !== s.control_epoch) fail('CONTROL_CHANGED', 'Control changed while typing. Review the unsubmitted terminal draft.');
        };
        if (s.provider === 'codex' && images.length) await this.tmux.pasteImages(target, images, checkControl);
        checkControl();
        this.tmux.paste(target, prompt);
        await delay(400);
        checkControl();
        this.tmux.enter(target);
        this.store.run("UPDATE requests SET status = 'awaiting_ack', delivered_at = ? WHERE session_id = ? AND request_id = ? AND status = 'delivering'", now(), s.id, requestId);
      } catch (error) { this.uncertain(s.id, requestId, error); throw error; }
      this.refresh(); return this.response(s.id, requestId);
    }
    if (action === 'stop') return this.stop(s, actor);
    fail('UNKNOWN_COMMAND', 'Unknown command.');
  }
  title(value) { if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\x00-\x1f]/.test(value)) fail('INVALID_TITLE', 'Use a title between 1 and 160 characters.'); return value.trim(); }
  async create(args) {
    if (!['codex', 'claude'].includes(args.provider)) fail('INVALID_PROVIDER', 'Provider must be codex or claude.');
    const owner = validateActor(args.owner || 'human');
    const inputImages = readImages(args.images);
    if (args.start !== undefined && typeof args.start !== 'boolean') fail('INVALID_START', 'start must be true or false.');
    // start launches the CLI even without a task; it then runs the small initialization turn.
    const hasTask = !!args.text || inputImages.length > 0 || args.start === true;
    if (!args.project || !path.isAbsolute(args.project)) fail('INVALID_PROJECT', 'Provide an absolute project directory.');
    let project;
    try { project = fs.realpathSync(args.project); if (!fs.statSync(project).isDirectory()) throw new Error('Not a directory'); } catch { fail('INVALID_PROJECT', 'Project directory does not exist.'); }
    // Without a name, the first task names the session, else the folder. A human rename makes it 'user', which nothing automatic replaces.
    const derived = args.title ? '' : taskTitle(args.text);
    const title = this.title(args.title || derived || path.basename(project));
    const titleSource = args.title ? 'user' : derived ? 'task' : 'folder';
    const cliArgs = validateCliArgs(args.provider, args.cliArgs || []);
    const id = args.id || randomUUID();
    if (!UUID.test(id)) fail('INVALID_SESSION_ID', 'Session ID must be a UUID.');
    const existing = this.store.get('SELECT * FROM sessions WHERE id = ?', id);
    if (existing) {
      // Without a name the title is automatic, and a retry may cross an upgrade that named it differently
      // (a version-5 controller used the folder), so any automatic name is the same creation.
      const sameTitle = existing.title === title || (!args.title && existing.title_source !== 'user');
      if (existing.provider !== args.provider || existing.project !== project || !sameTitle || existing.cli_args !== JSON.stringify(cliArgs)) fail('SESSION_ID_CONFLICT', 'Session ID already identifies a different session.');
      if (hasTask) return this.start(existing, args, owner, inputImages);
      return this.response(id, undefined, { duplicate: true });
    }
    if (args.text) validateText(args.text);
    this.store.transaction(() => {
      this.store.run('INSERT INTO sessions(id,title,title_source,provider,project,cli_args,owner,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id, title, titleSource, args.provider, project, JSON.stringify(cliArgs), owner, 'stopped', now(), now());
      this.store.audit('created', id, { provider: args.provider, project, owner, titleSource });
    });
    if (hasTask) return this.start(this.store.session(id), args, owner, inputImages);
    return this.response(id);
  }
  canSend(s) {
    const current = this.describe(s.id);
    if (!current.alive) fail('SESSION_STOPPED', 'Start the CLI before sending.');
    if (s.closing) fail('SESSION_CLOSING', 'Wait for the CLI to exit.');
    if (s.pending) fail('TURN_PENDING', 'Wait for the active turn to finish.');
    const run = this.store.runRecord(s.run_id);
    if (this.store.get("SELECT request_id FROM requests WHERE run_id = ? AND status IN ('intent','delivering','awaiting_ack','uncertain') LIMIT 1", s.run_id)) fail('REQUEST_UNRESOLVED', 'A previous delivery has no confirmed receipt. Inspect that request and the existing terminal before sending another task.');
    if (run?.attention) fail('CLI_NOT_READY', 'Hook journal integrity requires attention.');
    if (!current.hooksReady || !current.nativeSessionId || s.status !== 'ready') fail('CLI_NOT_READY', 'Open the terminal to resolve trust, permissions, or hook availability.');
  }
  pruneHistory(id) {
    const current = this.store.session(id);
    for (const run of this.store.all('SELECT * FROM runs WHERE session_id = ? AND ended_at IS NOT NULL AND id != ?', id, current.run_id || '')) {
      const panes = [...this.panes.values()].filter(pane => pane.name === run.tmux_name);
      if (!panes.length || panes.some(pane => pane.alive)) continue;
      const target = this.terminal(run, { read: true });
      try {
        const directory = path.join(this.config.home, 'runs', run.id);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (target) fs.writeFileSync(path.join(directory, 'final-screen.txt'), this.tmux.capture(target), { mode: 0o600 });
        if (this.tmux.removeDeadSession(run)) this.store.audit('dead_terminal_pruned', id, { runId: run.id });
      } catch (error) { this.store.audit('dead_terminal_prune_failed', id, { runId: run.id, error: error.message }); }
    }
  }
  async start(s, args, actor, preparedImages) {
    this.authorize(s, actor);
    await this.config.pathReady; // At most a few seconds, once per controller: CLIs start with the login shell's PATH.
    const inputImages = preparedImages || readImages(args.images);
    const text = validateText(args.text ?? (inputImages.length ? 'Describe the attached images.' : BOOTSTRAP));
    const payloadHash = imagePayloadHash(text, inputImages);
    const requestId = args.requestId || randomUUID();
    if (this.duplicate(s, requestId, payloadHash)) return this.response(s.id, requestId, { duplicate: true });
    if (this.describe(s.id).alive) { if (args.text || inputImages.length) fail('SESSION_ALIVE', 'Use send for an active CLI.'); return this.response(s.id); }
    if (args.action === 'resume' && !s.run_id) fail('SESSION_NOT_STARTED', 'The session has never been started.');
    const fresh = !s.run_id || this.unstarted(s);
    if (!fresh && (!s.native_id || !this.store.runRecord(s.run_id).hooks_ready)) fail('SESSION_ID_UNVERIFIED', 'The previous process did not confirm its identity; inspect its terminal before recovery.');
    const run = { id: randomUUID(), session_id: s.id, started_at: now() };
    run.tmux_name = 'harbor-' + run.id;
    const nativeId = (fresh ? null : s.native_id) || (s.provider === 'claude' ? randomUUID() : null);
    if (s.working_directory && !fs.existsSync(s.working_directory)) fail('WORKTREE_MISSING', 'The original working directory is missing. Restore it before resuming.');
    const images = stageImages(this.config, inputImages);
    const prompt = imagePrompt(s.provider, text, images);
    const command = launchCommand({ ...s, native_id: nativeId, resuming: !fresh }, this.config, prompt, images);
    fs.mkdirSync(path.join(this.config.home, 'runs', run.id), { mode: 0o700 });
    // Kept privately so the identical launch can be repeated once the folder is trusted.
    if (s.provider === 'claude' && fresh && usesWorktree(s)) fs.writeFileSync(path.join(this.config.home, 'runs', run.id, 'launch.json'), JSON.stringify(command), { mode: 0o600 });
    this.store.transaction(() => {
      this.store.run('INSERT INTO runs(id,session_id,tmux_name,started_at) VALUES(?,?,?,?)', run.id, s.id, run.tmux_name, run.started_at);
      this.newRequest(s, run, requestId, prompt, actor, images.length ? 'cli-initial-images' : 'cli-initial-prompt', payloadHash, images);
      this.store.run("UPDATE sessions SET native_id = ?, run_id = ?, pending = 1, active_turn = NULL, status = 'starting', closing = 0, error = NULL, updated_at = ? WHERE id = ?", nativeId, run.id, run.started_at, s.id);
      this.store.audit(fresh ? 'start_intent' : 'resume_intent', s.id, { requestId, runId: run.id, nativeSessionId: nativeId });
    });
    try {
      const launched = this.tmux.launch(run, { ...s, project: s.working_directory || s.project }, command);
      this.store.run('UPDATE runs SET pane_id = ?, pid = ? WHERE id = ?', launched.paneId, launched.pid, run.id);
      this.pruneHistory(s.id);
      this.store.run("UPDATE requests SET status = 'awaiting_ack', delivered_at = ? WHERE session_id = ? AND request_id = ? AND status = 'intent'", now(), s.id, requestId);
    } catch (error) { this.uncertain(s.id, requestId, error); throw error; }
    this.refresh(); return this.response(s.id, requestId);
  }
  // Pre-authorized folders change the trust decision for every project inside them, so only the human edits them.
  trustedFolders(args) {
    if (args.add !== undefined || args.remove !== undefined) {
      if ((args.actor || 'human') !== 'human') fail('TRUST_HUMAN_ONLY', 'Only the human can change trusted folders.');
      const folders = updateTrustedFolders(this.config, { add: args.add, remove: args.remove });
      this.store.audit('trusted_folders_changed', null, { add: args.add, remove: args.remove });
      return { ok: true, folders };
    }
    return { ok: true, folders: trustedFolders(this.config) };
  }
  // The human answers the CLI's own trust dialog from Harbor, whoever controls the session.
  async trust(s, args) {
    if ((args.actor || 'human') !== 'human') fail('TRUST_HUMAN_ONLY', 'Only the human can trust a folder.');
    if (s.archived_at) fail('SESSION_ARCHIVED', 'Archived sessions cannot be changed.');
    const run = this.store.runRecord(s.run_id);
    const live = run && this.terminal(run);
    const read = () => { try { return live ? trustPrompt(s.provider, this.tmux.screen(live)) : null; } catch { return null; } };
    let prompt = read();
    if (!prompt) fail('TRUST_PROMPT_ABSENT', 'No trust prompt is waiting in this session.');
    if (args.folder !== undefined) {
      const folder = prompt.kind === 'folder' && prompt.folder || s.working_directory || s.project;
      if (typeof args.folder !== 'string' || !path.isAbsolute(args.folder) || !folderInside(fs.realpathSync(args.folder), fs.realpathSync(folder))) fail('INVALID_TRUSTED_FOLDER', 'The trusted folder must contain the folder the CLI asks about.');
      updateTrustedFolders(this.config, { add: args.folder });
      this.store.audit('trusted_folders_changed', s.id, { add: args.folder });
    }
    if (!this.dialogSince.has(run.id)) this.dialogSince.set(run.id, Date.now());
    if (!this.dialogSettled(run)) await delay(1500 - (Date.now() - this.dialogSince.get(run.id)));
    prompt = read();
    // Select the trusting choice. A second key only if the screen did not react at all, so a slow redraw
    // never moves the selection twice; Enter waits for the trusting choice either way.
    for (let tries = 0; tries < 2 && prompt && prompt.selected !== 'accept' && prompt.navigate; tries++) {
      const before = this.tmux.screen(live);
      this.tmux.key(live, 'Down');
      let changed = false;
      for (let attempt = 0; attempt < 40 && prompt?.selected !== 'accept'; attempt++) { await delay(100); prompt = read(); if (this.tmux.screen(live) !== before) { changed = true; if (attempt >= 5) break; } }
      if (changed) break;
    }
    if (prompt?.selected !== 'accept') fail('TRUST_PROMPT_CHANGED', 'The trust prompt did not show the expected choice. Answer it in the terminal.');
    this.tmux.key(live, 'Enter');
    this.keys.set(run.id, { ...this.keys.get(run.id), ['accept:' + prompt.kind]: Date.now(), ['select:' + prompt.kind]: Date.now(), last: Date.now() });
    if (prompt.kind === 'folder') this.store.run("UPDATE runs SET trust = 'accepted', trust_folder = COALESCE(?, trust_folder) WHERE id = ?", prompt.folder, run.id);
    this.store.audit('trust_approved', s.id, { runId: run.id, kind: prompt.kind, folder: prompt.folder });
    await delay(300);
    this.refresh(); return this.response(s.id);
  }
  // Every launch died at Claude's worktree trust check, before any conversation existed (for example under a controller
  // older than the trust helper). Starting again is a first launch, not a resume.
  unstarted(s) {
    if (s.provider !== 'claude' || this.store.get('SELECT 1 FROM runs WHERE session_id = ? AND hooks_ready = 1 LIMIT 1', s.id)) return false;
    const run = this.store.runRecord(s.run_id);
    if (!run?.ended_at) return false;
    let screen = '';
    try { const target = this.terminal(run, { read: true }); if (target) screen = this.tmux.capture(target); } catch {}
    if (!screen) try { screen = fs.readFileSync(path.join(this.config.home, 'runs', run.id, 'final-screen.txt'), 'utf8'); } catch {}
    return WORKTREE_TRUST_ERROR.test(screen);
  }
  uncertain(id, requestId, error) {
    this.store.run("UPDATE requests SET status = 'uncertain', error = ? WHERE session_id = ? AND request_id = ? AND accepted_at IS NULL", error.message, id, requestId);
    this.store.run("UPDATE sessions SET status = 'attention', error = 'DELIVERY_UNCERTAIN' WHERE id = ?", id);
    this.store.audit('delivery_uncertain', id, { requestId, error: error.message });
  }
  async stop(s, actor) {
    const run = this.store.runRecord(s.run_id);
    const target = this.terminal(run);
    if (!target) return this.response(s.id);
    if (!s.closing) {
      this.canSend(s);
      this.store.run('UPDATE sessions SET closing = 1, updated_at = ? WHERE id = ?', now(), s.id);
      this.store.audit('stop_intent', s.id, { runId: run.id, pid: run.pid });
      this.tmux.exit(target);
    }
    await delay(400);
    const currentOwner = this.store.session(s.id);
    this.authorize(currentOwner, actor);
    if (currentOwner.control_epoch !== s.control_epoch) fail('CONTROL_CHANGED', 'Control changed during closure. Review the terminal before retrying.');
    this.tmux.enter(target);
    const deadline = Date.now() + this.config.stopTimeout;
    do {
      await delay(200); this.refresh();
      const current = this.describe(s.id);
      if (current.runId !== run.id) fail('RUN_CHANGED', 'A different process now owns this session.');
      if (!current.alive) return this.response(s.id);
    } while (Date.now() < deadline);
    fail('STOP_TIMEOUT', 'CLI did not exit; no process was forcibly terminated. Open the terminal or retry stop.');
  }
}
