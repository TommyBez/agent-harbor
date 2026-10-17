import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT, configuration, ensurePrivateHome, HarborError, fail } from './common.mjs';

export async function rpc(action, args = {}, { config = configuration(), onEvent, autoStart = true, timeoutMs } = {}) {
  let attempts = 0;
  for (;;) {
    try { return await exchange(config, action, args, onEvent, timeoutMs); }
    catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code) || !autoStart) throw error;
      if (attempts++ === 0) startDaemon(config);
      if (attempts > 60) fail('DAEMON_UNAVAILABLE', `Daemon did not start. Inspect ${path.join(config.home, 'logs/daemon.log')}.`);
      await delay(100);
    }
  }
}
function startDaemon(config) {
  ensurePrivateHome(config);
  const log = fs.openSync(path.join(config.home, 'logs/daemon.log'), 'a', 0o600);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'broker/daemon.mjs')], {
    cwd: config.home, detached: true, stdio: ['ignore', log, log], env: { ...process.env, HARBOR_HOME: config.home },
  });
  child.unref(); fs.closeSync(log);
}
function exchange(config, action, args, onEvent, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(config.socket);
    let buffer = '', settled = false, received = false;
    const milliseconds = timeoutMs ?? (action === 'wait' ? Number(args.timeout ?? 120000) + 10000 : action === 'stop' ? 30000 : 15000);
    const deadline = setTimeout(() => {
      settled = true; socket.destroy();
      reject(new HarborError('RPC_TIMEOUT', `No daemon response within ${milliseconds} milliseconds. Retry mutations only with the same request ID.`));
    }, milliseconds);
    socket.once('close', () => {
      clearTimeout(deadline);
      if (!settled && !received) reject(new HarborError('DAEMON_DISCONNECTED', 'Daemon disconnected; request state is durable. Retry with the same request ID.'));
    });
    const id = randomUUID();
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(JSON.stringify({ id, action, args }) + '\n'));
    socket.on('error', reject);
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { socket.destroy(); reject(new HarborError('RESPONSE_TOO_LARGE', 'Daemon response exceeded 16 MiB.')); return; }
      for (;;) {
        const split = buffer.indexOf('\n'); if (split < 0) break;
        const line = buffer.slice(0, split); buffer = buffer.slice(split + 1);
        let response;
        try { response = JSON.parse(line); } catch { socket.destroy(); reject(new HarborError('PROTOCOL_ERROR', 'Daemon returned invalid JSON.')); return; }
        if (response.id !== id) continue;
        received = true; clearTimeout(deadline);
        if (!response.ok) { settled = true; socket.end(); reject(new HarborError(response.error.code, response.error.message, response.error.details)); return; }
        const { id: _id, ...result } = response;
        if (onEvent) onEvent(result);
        else { settled = true; socket.end(); resolve(result); }
      }
    });
    socket.once('end', () => { if (onEvent) resolve(); else if (!settled) reject(new HarborError('DAEMON_DISCONNECTED', 'Daemon disconnected; request state is durable. Retry with the same request ID.')); });
  });
}
