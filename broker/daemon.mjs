import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { configuration, ensurePrivateHome, errorJSON, now, processAlive, fail, compareVersions, VERSION, loginShellPath, sessionPath } from './common.mjs';
import { Store } from './store.mjs';
import { Tmux } from './tmux.mjs';
import { Service } from './service.mjs';

process.umask(0o077);
const config = configuration();
ensurePrivateHome(config);
const lock = path.join(config.home, 'daemon.lock');
function acquireLock() {
  const readOwner = () => {
    try { return JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')); }
    catch { if (Date.now() - fs.statSync(lock).mtimeMs < 10000) fail('DAEMON_STARTING', 'Another daemon is starting.'); fail('LOCK_INVALID', 'Daemon lock is malformed; inspect it before recovery.'); }
  };
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (processAlive(readOwner().pid)) fail('DAEMON_ALREADY_RUNNING', 'Another daemon already owns this state directory.');
    // Serialize stale-lock recovery and re-read the owner while holding the gate.
    // Never unlink a replacement lock installed by another starter.
    const gate = path.join(config.home, 'daemon-recovery.lock');
    try { fs.mkdirSync(gate, { mode: 0o700 }); }
    catch (gateError) { if (gateError.code === 'EEXIST') fail('DAEMON_RECOVERING', 'Another daemon is recovering its lock. If no daemon starts, inspect daemon-recovery.lock.'); throw gateError; }
    try {
      fs.writeFileSync(path.join(gate, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: now() }), { mode: 0o600 });
      if (fs.existsSync(lock)) {
        if (processAlive(readOwner().pid)) fail('DAEMON_ALREADY_RUNNING', 'Another daemon already recovered the lock.');
        fs.rmSync(lock, { recursive: true });
      }
      fs.mkdirSync(lock, { mode: 0o700 });
    } finally { fs.rmSync(gate, { recursive: true }); }
  }
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: now() }), { mode: 0o600 });
}

let store, timer, server;
const watchers = new Map();
let lastSnapshot;
function cleanup() {
  clearInterval(timer);
  for (const socket of watchers.keys()) socket.destroy();
  server?.close();
  try { fs.unlinkSync(config.socket); } catch {}
  try { fs.rmSync(lock, { recursive: true }); } catch {}
  store?.close();
}
try {
  acquireLock();
  store = new Store(config.database);
  config.sessionPath = sessionPath(config.env);
  config.pathReady = loginShellPath(config.env).then(found => { if (found) config.sessionPath = sessionPath(config.env, found); });
  const service = new Service(config, store, new Tmux(config));
  service.recoverCwdIncidents();
  // Interrupted delivery is not automatically replayed. Hooks may still resolve it.
  store.run("UPDATE requests SET status = 'uncertain', error = 'DAEMON_RESTARTED_DURING_DELIVERY' WHERE status IN ('intent','delivering')");
  service.refresh();
  try { fs.unlinkSync(config.socket); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  server = net.createServer(socket => {
    socket.setEncoding('utf8');
    let buffer = '', handled = false;
    socket.setTimeout(5000, () => { if (!handled) socket.destroy(); });
    socket.on('error', () => {});
    socket.on('close', () => watchers.delete(socket));
    socket.on('data', async chunk => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1024 * 1024) { handled = true; socket.setTimeout(0); socket.end(JSON.stringify({ ok: false, error: { code: 'REQUEST_TOO_LARGE', message: 'Request exceeds 1 MiB.' } }) + '\n', () => socket.destroy()); return; }
      const newline = buffer.indexOf('\n'); if (newline < 0) return;
      handled = true; socket.setTimeout(0);
      let request;
      try {
        request = JSON.parse(buffer.slice(0, newline));
        if (typeof request.id !== 'string' || typeof request.action !== 'string' || !request.args || typeof request.args !== 'object') fail('INVALID_REQUEST', 'Invalid IPC request.');
        if (request.action === 'shutdown') {
          // A newer installation replaces this controller. CLIs keep running in tmux and the next daemon adopts them.
          if (compareVersions(request.args.version, VERSION) <= 0) fail('DAEMON_NOT_OLDER', `Only a newer Agent Harbor can replace controller ${VERSION}.`);
          if (service.queues.size) fail('DAEMON_BUSY', 'A session operation is in progress. Retry shortly.');
          socket.end(JSON.stringify({ id: request.id, ok: true, version: VERSION }) + '\n', () => { cleanup(); process.exit(0); });
          return;
        }
        const response = await service.execute(request.action, request.args);
        socket.write(JSON.stringify({ id: request.id, ...response }) + '\n');
        if (request.action === 'watch') watchers.set(socket, { id: request.id, args: request.args, previous: JSON.stringify(response) });
        else socket.end();
      } catch (error) { socket.end(JSON.stringify({ id: request?.id, ok: false, error: errorJSON(error) }) + '\n'); }
    });
  });
  server.once('error', error => { process.stderr.write(JSON.stringify({ error: errorJSON(error) }) + '\n'); cleanup(); process.exit(1); });
  server.listen(config.socket, () => fs.chmodSync(config.socket, 0o600));
  timer = setInterval(async () => {
    try {
      service.refresh();
      for (const [socket, watcher] of watchers) {
        const response = { ok: true, sessions: store.all(`SELECT id FROM sessions ${watcher.args.archived ? '' : 'WHERE archived_at IS NULL'} ORDER BY created_at DESC`).map(s => service.describe(s.id, !!watcher.args.compact)) };
        const serialized = JSON.stringify(response);
        if (serialized === watcher.previous) continue;
        watcher.previous = serialized;
        if (socket.writableLength > 1024 * 1024) { socket.destroy(); continue; }
        socket.write(JSON.stringify({ id: watcher.id, ...response }) + '\n');
      }
      lastSnapshot = null;
    } catch (error) {
      const serialized = JSON.stringify(errorJSON(error));
      if (serialized !== lastSnapshot) process.stderr.write(serialized + '\n');
      lastSnapshot = serialized;
    }
  }, 1000);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { cleanup(); process.exit(0); });
} catch (error) {
  process.stderr.write(JSON.stringify({ time: now(), error: errorJSON(error) }) + '\n');
  if (store) cleanup();
  process.exitCode = 1;
}
