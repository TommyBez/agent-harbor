import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { now, fail, hashPrompt, hashPayload, validateText, validateActor, executable, CLI } from './common.mjs';
import { importEvents } from './events.mjs';
import { validateCliArgs } from './arguments.mjs';
import { launchCommand } from './providers.mjs';

const FINISHED = new Set(['completed', 'failed', 'interrupted']);
const BOOTSTRAP = 'Initialize this interactive session. Reply only READY. Do not use tools or modify files.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class Service {
  constructor(config, store, tmux) { this.config = config; this.store = store; this.tmux = tmux; this.panes = new Map(); this.queues = new Map(); }
  refresh() {
    this.panes = this.tmux.panes();
    for (const session of this.store.all('SELECT * FROM sessions WHERE run_id IS NOT NULL AND archived_at IS NULL')) {
      let run = this.store.runRecord(session.run_id);
      importEvents(this.store, this.config, run);
      run = this.store.runRecord(session.run_id);
      const pane = this.pane(run);
      const alive = !!pane?.alive;
      if (alive) {
        if (run.pid !== pane.pid || run.pane_id !== pane.id) this.store.run('UPDATE runs SET pid = ?, pane_id = ? WHERE id = ?', pane.pid, pane.id, run.id);
        const current = this.store.session(session.id);
        if (run.attention) { this.store.run("UPDATE sessions SET status = 'attention', error = ? WHERE id = ?", run.attention, session.id); }
        if (!run.hooks_ready && Date.now() - Date.parse(run.started_at) > this.config.startupTimeout) {
          this.store.run("UPDATE sessions SET status = 'attention', error = 'HOOKS_NOT_READY' WHERE id = ?", session.id);
        } else {
          const delivery = this.store.get("SELECT created_at FROM requests WHERE run_id = ? AND status IN ('intent','delivering','awaiting_ack','uncertain') ORDER BY created_at DESC LIMIT 1", run.id);
          if (delivery && Date.now() - Date.parse(delivery.created_at) > this.config.startupTimeout && current.status !== 'attention') this.store.run("UPDATE sessions SET status = 'attention', error = 'PROMPT_NOT_ACKNOWLEDGED' WHERE id = ?", session.id);
        }

      } else if (!run.ended_at) {
        const time = now();
        this.store.transaction(() => {
          this.store.run('UPDATE runs SET ended_at = ? WHERE id = ?', time, run.id);
          this.store.run("UPDATE requests SET status = 'interrupted', error = 'PROCESS_EXITED', completed_at = ? WHERE run_id = ? AND status NOT IN ('completed','failed','interrupted')", time, run.id);
          this.store.run("UPDATE sessions SET status = 'stopped', pending = 0, closing = 0, updated_at = ? WHERE id = ?", time, session.id);
          this.store.audit('process_exited', session.id, { runId: run.id, pid: run.pid });
        });
      }
    }
    this.tmux.syncOwnership(this.store.all('SELECT id,owner,run_id FROM sessions WHERE run_id IS NOT NULL AND archived_at IS NULL').map(s => ({ ...s, tmuxName: this.store.runRecord(s.run_id).tmux_name })));
  }
  pane(run) {
    if (!run) return null;
    return run.pane_id ? this.panes.get(run.pane_id) : [...this.panes.values()].find(p => p.name === run.tmux_name && p.windowIndex === 0 && p.paneIndex === 0);
  }
  describe(id, compact = false) {
    const s = this.store.session(id);
    const run = this.store.runRecord(s.run_id);
    const pane = this.pane(run);
    const result = { id: s.id, title: s.title, provider: s.provider, project: s.project, workingDirectory: s.working_directory || s.project, owner: s.owner, alive: !!pane?.alive,
      status: s.status, nativeSessionId: s.native_id, pending: !!s.pending, closing: !!s.closing, error: s.error,
      createdAt: s.created_at, updatedAt: s.updated_at, archivedAt: s.archived_at, runId: s.run_id, pid: pane?.pid || run?.pid || null };
    if (!compact) Object.assign(result, { cliArgs: JSON.parse(s.cli_args || '[]'), hooksReady: !!run?.hooks_ready, lastResponse: s.last_response, lastResponseAt: s.last_response_at,
      attachCommand: process.execPath, attachArgs: [CLI, 'attach', id], terminal: run ? { command: this.tmux.binary, args: this.tmux.args(run, s.owner !== 'human') } : null });
    return result;
  }
  request(id, requestId) {
    const r = requestId ? this.store.request(id, requestId) : this.store.get('SELECT * FROM requests WHERE session_id = ? ORDER BY created_at DESC LIMIT 1', id);
    if (!r && requestId) fail('REQUEST_NOT_FOUND', 'Request not found.');
    return r ? { requestId: r.request_id, sessionId: r.session_id, runId: r.run_id, status: r.status, actor: r.actor,
      accepted: !!r.accepted_at, nativeTurnId: r.native_turn_id, response: r.response, error: r.error,
      createdAt: r.created_at, acceptedAt: r.accepted_at, completedAt: r.completed_at, transport: r.transport } : null;
  }
  response(id, requestId, extra = {}) { return { ok: true, session: this.describe(id), ...(requestId ? { request: this.request(id, requestId) } : {}), ...extra }; }
  async execute(action, args = {}) {
    if (['watch', 'list', 'result', 'capture', 'doctor', 'attach-info', 'wait', 'events'].includes(action)) return this.read(action, args);
    if (action === 'control') return this.mutate(action, args);
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
      return { ok: true, node: process.version, daemonPid: process.pid, home: this.config.home, database: this.config.database, socket: this.config.socket, schemaVersion: 3, dependencies };
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
    if (action === 'capture') { const run = this.store.runRecord(session.runId); return { ok: true, session, screen: run && this.pane(run) ? this.tmux.capture(run) : '' }; }
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
        const outcome = current.status === 'attention' && request.status === 'completed' ? 'attention' : FINISHED.has(request.status) && settled ? request.status : current.status === 'attention' ? 'attention' : Date.now() >= deadline ? 'timeout' : null;
        if (outcome) return { ok: true, outcome, session: current, request };
        await delay(Math.min(200, Math.max(1, deadline - Date.now())));
      }
    }
    fail('UNKNOWN_COMMAND', 'Unknown command.');
  }
  authorize(session, actor) { validateActor(actor); if (session.owner !== actor) fail('CONTROL_DENIED', `The session is controlled by ${session.owner}.`); if (session.archived_at) fail('SESSION_ARCHIVED', 'Archived sessions cannot be started or changed.'); }
  duplicate(session, requestId, text) {
    const existing = this.store.request(session.id, requestId);
    if (!existing) return false;
    if (existing.payload_hash !== hashPayload(text)) fail('REQUEST_ID_CONFLICT', 'This request ID was already used with different text.');
    return true;
  }
  newRequest(session, run, requestId, text, actor, transport) {
    if (!requestId || typeof requestId !== 'string' || requestId.length > 200 || /[\x00-\x1f]/.test(requestId)) fail('INVALID_REQUEST_ID', 'Request ID must contain 1–200 printable characters.');
    this.store.run('INSERT INTO requests(session_id,request_id,run_id,prompt_hash,payload_hash,status,actor,created_at,transport) VALUES(?,?,?,?,?,?,?,?,?)', session.id, requestId, run.id, hashPrompt(text), hashPayload(text), 'intent', actor, now(), transport);
  }
  async mutate(action, args) {
    this.refresh();
    if (action === 'create') return this.create(args);
    let s = this.store.session(args.id);
    if (action === 'rename') { const title = this.title(args.title); this.store.run('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?', title, now(), s.id); return this.response(s.id); }
    if (action === 'control') {
      validateActor(args.owner);
      const actor = validateActor(args.actor || 'human');
      if (s.owner === 'human' && args.owner === 'grok' && actor !== 'human') fail('CONTROL_DENIED', 'Only the human can return their session to Grok.');
      if (s.archived_at) fail('SESSION_ARCHIVED', 'Archived session cannot change ownership.');
      if (s.owner === 'human' && args.owner === 'grok' && (s.pending || s.closing)) fail('TURN_PENDING', 'Let the human turn finish before returning control to Grok.');
      const run = this.store.runRecord(s.run_id);
      if (run && this.pane(run)?.alive) this.tmux.enforce(run, args.owner);
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
    const actor = args.actor || 'human';
    this.authorize(s, actor);
    if (action === 'start' || action === 'resume') return this.start(s, { ...args, action }, actor);
    if (action === 'send') {
      const text = validateText(args.text);
      const requestId = args.requestId || randomUUID();
      if (this.duplicate(s, requestId, text)) return this.response(s.id, requestId, { duplicate: true });
      this.canSend(s);
      const run = this.store.runRecord(s.run_id);
      this.store.transaction(() => { this.newRequest(s, run, requestId, text, actor, 'terminal-paste'); this.store.run("UPDATE sessions SET pending = 1, status = 'running', updated_at = ? WHERE id = ?", now(), s.id); this.store.audit('send_intent', s.id, { requestId, runId: run.id }); });
      try {
        this.store.run("UPDATE requests SET status = 'delivering' WHERE session_id = ? AND request_id = ?", s.id, requestId);
        this.tmux.paste(run, text);
        await delay(400);
        const current = this.store.session(s.id);
        this.authorize(current, actor);
        if (current.control_epoch !== s.control_epoch) fail('CONTROL_CHANGED', 'Control changed while typing. Review the unsubmitted terminal draft.');
        this.tmux.enter(run);
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
    if (!args.project || !path.isAbsolute(args.project)) fail('INVALID_PROJECT', 'Provide an absolute project directory.');
    let project;
    try { project = fs.realpathSync(args.project); if (!fs.statSync(project).isDirectory()) throw new Error('Not a directory'); } catch { fail('INVALID_PROJECT', 'Project directory does not exist.'); }
    const title = this.title(args.title || path.basename(project));
    const cliArgs = validateCliArgs(args.provider, args.cliArgs || []);
    const id = args.id || randomUUID();
    if (!UUID.test(id)) fail('INVALID_SESSION_ID', 'Session ID must be a UUID.');
    const existing = this.store.get('SELECT * FROM sessions WHERE id = ?', id);
    if (existing) {
      if (existing.provider !== args.provider || existing.project !== project || existing.title !== title || existing.cli_args !== JSON.stringify(cliArgs)) fail('SESSION_ID_CONFLICT', 'Session ID already identifies a different session.');
      if (args.text) return this.start(existing, args, owner);
      return this.response(id, undefined, { duplicate: true });
    }
    if (args.text) validateText(args.text);
    this.store.transaction(() => {
      this.store.run('INSERT INTO sessions(id,title,provider,project,cli_args,owner,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', id, title, args.provider, project, JSON.stringify(cliArgs), owner, 'stopped', now(), now());
      this.store.audit('created', id, { provider: args.provider, project, owner });
    });
    if (args.text) return this.start(this.store.session(id), args, owner);
    return this.response(id);
  }
  canSend(s) {
    const current = this.describe(s.id);
    if (!current.alive) fail('SESSION_STOPPED', 'Start the CLI before sending.');
    if (s.closing) fail('SESSION_CLOSING', 'Wait for the CLI to exit.');
    if (s.pending) fail('TURN_PENDING', 'Wait for the active turn to finish.');
    const run = this.store.runRecord(s.run_id);
    if (run?.attention) fail('CLI_NOT_READY', 'Hook journal integrity requires attention.');
    if (!current.hooksReady || !current.nativeSessionId || s.status !== 'ready') fail('CLI_NOT_READY', 'Open the terminal to resolve trust, permissions, or hook availability.');
  }
  pruneHistory(id) {
    const current = this.store.session(id);
    for (const run of this.store.all('SELECT * FROM runs WHERE session_id = ? AND ended_at IS NOT NULL AND id != ?', id, current.run_id || '')) {
      const panes = [...this.panes.values()].filter(pane => pane.name === run.tmux_name);
      if (!panes.length || panes.some(pane => pane.alive)) continue;
      const pane = this.pane(run);
      try {
        const directory = path.join(this.config.home, 'runs', run.id);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (pane) fs.writeFileSync(path.join(directory, 'final-screen.txt'), this.tmux.capture({ ...run, pane_id: pane.id }), { mode: 0o600 });
        if (this.tmux.removeDeadSession(run)) this.store.audit('dead_terminal_pruned', id, { runId: run.id });
      } catch (error) { this.store.audit('dead_terminal_prune_failed', id, { runId: run.id, error: error.message }); }
    }
  }
  async start(s, args, actor) {
    this.authorize(s, actor);
    const text = validateText(args.text || BOOTSTRAP);
    const requestId = args.requestId || randomUUID();
    if (this.duplicate(s, requestId, text)) return this.response(s.id, requestId, { duplicate: true });
    if (this.describe(s.id).alive) { if (args.text) fail('SESSION_ALIVE', 'Use send for an active CLI.'); return this.response(s.id); }
    if (args.action === 'resume' && !s.run_id) fail('SESSION_NOT_STARTED', 'The session has never been started.');
    if (s.run_id && (!s.native_id || !this.store.runRecord(s.run_id).hooks_ready)) fail('SESSION_ID_UNVERIFIED', 'The previous process did not confirm its identity; inspect its terminal before recovery.');
    const run = { id: randomUUID(), session_id: s.id, started_at: now() };
    run.tmux_name = 'harbor-' + run.id;
    const nativeId = s.native_id || (s.provider === 'claude' ? randomUUID() : null);
    if (s.working_directory && !fs.existsSync(s.working_directory)) fail('WORKTREE_MISSING', 'The original working directory is missing. Restore it before resuming.');
    const command = launchCommand({ ...s, native_id: nativeId, resuming: !!s.run_id }, this.config, text);
    fs.mkdirSync(path.join(this.config.home, 'runs', run.id), { mode: 0o700 });
    this.store.transaction(() => {
      this.store.run('INSERT INTO runs(id,session_id,tmux_name,started_at) VALUES(?,?,?,?)', run.id, s.id, run.tmux_name, run.started_at);
      this.newRequest(s, run, requestId, text, actor, 'cli-initial-prompt');
      this.store.run("UPDATE sessions SET native_id = ?, run_id = ?, pending = 1, active_turn = NULL, status = 'starting', closing = 0, error = NULL, updated_at = ? WHERE id = ?", nativeId, run.id, run.started_at, s.id);
      this.store.audit(s.run_id ? 'resume_intent' : 'start_intent', s.id, { requestId, runId: run.id, nativeSessionId: nativeId });
    });
    try {
      const launched = this.tmux.launch(run, { ...s, project: s.working_directory || s.project }, command);
      this.store.run('UPDATE runs SET pane_id = ?, pid = ? WHERE id = ?', launched.paneId, launched.pid, run.id);
      this.pruneHistory(s.id);
      this.store.run("UPDATE requests SET status = 'awaiting_ack', delivered_at = ? WHERE session_id = ? AND request_id = ? AND status = 'intent'", now(), s.id, requestId);
    } catch (error) { this.uncertain(s.id, requestId, error); throw error; }
    this.refresh(); return this.response(s.id, requestId);
  }
  uncertain(id, requestId, error) {
    this.store.run("UPDATE requests SET status = 'uncertain', error = ? WHERE session_id = ? AND request_id = ? AND accepted_at IS NULL", error.message, id, requestId);
    this.store.run("UPDATE sessions SET status = 'attention', error = 'DELIVERY_UNCERTAIN' WHERE id = ?", id);
    this.store.audit('delivery_uncertain', id, { requestId, error: error.message });
  }
  async stop(s, actor) {
    if (!this.describe(s.id).alive) return this.response(s.id);
    const run = this.store.runRecord(s.run_id);
    if (!s.closing) {
      this.canSend(s);
      this.store.run('UPDATE sessions SET closing = 1, updated_at = ? WHERE id = ?', now(), s.id);
      this.store.audit('stop_intent', s.id, { runId: run.id, pid: run.pid });
      this.tmux.exit(run);
    }
    await delay(400);
    const currentOwner = this.store.session(s.id);
    this.authorize(currentOwner, actor);
    if (currentOwner.control_epoch !== s.control_epoch) fail('CONTROL_CHANGED', 'Control changed during closure. Review the terminal before retrying.');
    this.tmux.enter(run);
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
