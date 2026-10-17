import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { now, fail } from './common.mjs';

export class Store {
  constructor(filename) {
    try {
      this.db = new DatabaseSync(filename);
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
      const check = this.db.prepare('PRAGMA quick_check').get().quick_check;
      if (check !== 'ok') fail('DATABASE_CORRUPT', check);
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > 3) fail('SCHEMA_TOO_NEW', 'The database was created by a newer version of Agent Harbor.');
      if (version === 0) this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),
          project TEXT NOT NULL, working_directory TEXT, cli_args TEXT NOT NULL DEFAULT '[]', owner TEXT NOT NULL CHECK(owner IN ('human','grok')), status TEXT NOT NULL,
          native_id TEXT, run_id TEXT, pending INTEGER NOT NULL DEFAULT 0, active_turn TEXT, control_epoch INTEGER NOT NULL DEFAULT 0,
          last_response TEXT, last_response_at TEXT, error TEXT, closing INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
        );
        CREATE TABLE runs (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), tmux_name TEXT NOT NULL UNIQUE,
          started_at TEXT NOT NULL, ended_at TEXT, pid INTEGER, pane_id TEXT, hooks_ready INTEGER NOT NULL DEFAULT 0,
          offset INTEGER NOT NULL DEFAULT 0, attention TEXT
        );
        CREATE TABLE requests (
          session_id TEXT NOT NULL REFERENCES sessions(id), request_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id),
          prompt_hash TEXT NOT NULL, payload_hash TEXT NOT NULL, status TEXT NOT NULL, actor TEXT NOT NULL,
          created_at TEXT NOT NULL, delivered_at TEXT, accepted_at TEXT, completed_at TEXT,
          native_turn_id TEXT, response TEXT, error TEXT, transport TEXT NOT NULL,
          PRIMARY KEY(session_id, request_id)
        );
        CREATE INDEX requests_run ON requests(run_id, status);
        CREATE TABLE events (seq INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), source_offset INTEGER NOT NULL,
          time TEXT NOT NULL, event_name TEXT NOT NULL, native_id TEXT, turn_id TEXT, payload TEXT NOT NULL,
          UNIQUE(run_id, source_offset));
        CREATE INDEX events_run ON events(run_id, seq);
        CREATE TABLE audit (seq INTEGER PRIMARY KEY, time TEXT NOT NULL, action TEXT NOT NULL, session_id TEXT, details TEXT NOT NULL);
        PRAGMA user_version=3; COMMIT;`);
      if (version === 1) this.transaction(() => {
        const columns = table => new Set(this.all('PRAGMA table_info(' + table + ')').map(column => column.name));
        if (!columns('runs').has('pane_id')) this.db.exec('ALTER TABLE runs ADD COLUMN pane_id TEXT');
        if (!columns('sessions').has('control_epoch')) this.db.exec('ALTER TABLE sessions ADD COLUMN control_epoch INTEGER NOT NULL DEFAULT 0');
        if (!columns('requests').has('payload_hash')) {
          this.db.exec('ALTER TABLE requests ADD COLUMN payload_hash TEXT');
          this.db.exec('UPDATE requests SET payload_hash = prompt_hash WHERE payload_hash IS NULL');
        }
        this.db.exec('PRAGMA user_version=2');
      });
      if (version === 1 || version === 2) this.transaction(() => {
        const columns = new Set(this.all('PRAGMA table_info(sessions)').map(column => column.name));
        if (!columns.has('cli_args')) this.db.exec("ALTER TABLE sessions ADD COLUMN cli_args TEXT NOT NULL DEFAULT '[]'");
        if (!columns.has('working_directory')) this.db.exec('ALTER TABLE sessions ADD COLUMN working_directory TEXT');
        this.db.exec('PRAGMA user_version=3');
      });
      fs.chmodSync(filename, 0o600);
    } catch (error) { this.db?.close(); if (error.code?.startsWith('SQLITE') || !error.code) fail('DATABASE_UNAVAILABLE', `State database could not be opened; it was not reset: ${error.message}`); throw error; }
  }
  get(sql, ...values) { return this.db.prepare(sql).get(...values); }
  all(sql, ...values) { return this.db.prepare(sql).all(...values); }
  iterate(sql, ...values) { return this.db.prepare(sql).iterate(...values); }
  run(sql, ...values) { return this.db.prepare(sql).run(...values); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  session(id) { if (typeof id !== 'string' || !id) fail('INVALID_SESSION_ID', 'A session ID is required.'); const result = this.get('SELECT * FROM sessions WHERE id = ?', id); if (!result) fail('SESSION_NOT_FOUND', 'Session not found.'); return result; }
  runRecord(id) { return id ? this.get('SELECT * FROM runs WHERE id = ?', id) : null; }
  request(id, requestId) { return this.get('SELECT * FROM requests WHERE session_id = ? AND request_id = ?', id, requestId); }
  audit(action, id, details = {}) { this.run('INSERT INTO audit(time,action,session_id,details) VALUES(?,?,?,?)', now(), action, id || null, JSON.stringify(details)); }
  close() { this.db.close(); }
}
