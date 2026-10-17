import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { rpc } from '../../broker/client.mjs';
import { configuration } from '../../broker/common.mjs';

function homeFor(t) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'harbor-ipc-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
async function stubServer(config, handle) {
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); handle(socket); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.socket, resolve); });
  return async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); };
}

test('RPC times out if a local peer accepts a request but never returns a response', { timeout: 2000 }, async t => {
  const config = configuration({ HARBOR_HOME: homeFor(t) });
  const close = await stubServer(config, () => {});
  try {
    const started = Date.now();
    await assert.rejects(rpc('list', {}, { config, autoStart: false, timeoutMs: 80 }), { code: 'RPC_TIMEOUT' });
    assert.ok(Date.now() - started < 1000);
  } finally { await close(); }
});

test('an old controller cannot silently discard requested images', async t => {
  const config = configuration({ HARBOR_HOME: homeFor(t) });
  const actions = [];
  const close = await stubServer(config, socket => socket.once('data', data => {
    const request = JSON.parse(data.toString()); actions.push(request.action);
    socket.end(JSON.stringify({ id: request.id, ok: true, schemaVersion: 3 }) + '\n');
  }));
  try {
    await assert.rejects(rpc('send', { id:'session',text:'look',images:['/image.png'],requestId:'visual' }, {config,autoStart:false}), {code:'DAEMON_UPGRADE_REQUIRED'});
    assert.deepEqual(actions,['doctor'], 'No mutation may reach the old controller.');
  } finally {await close();}
});

test('a watch startup deadline does not disconnect a healthy quiet subscription', { timeout: 2000 }, async t => {
  const config = configuration({ HARBOR_HOME: homeFor(t) });
  const close = await stubServer(config, socket => {
    socket.once('data', data => {
      const request = JSON.parse(data.toString());
      socket.write(JSON.stringify({ id: request.id, ok: true, sessions: [] }) + '\n');
      setTimeout(() => socket.end(), 180);
    });
  });
  try {
    const snapshots = [];
    await rpc('watch', { compact: true }, { config, autoStart: false, timeoutMs: 80, onEvent: value => snapshots.push(value) });
    assert.equal(snapshots.length, 1);
  } finally { await close(); }
});

function rawExchange(socketPath, payload, timeout = 7000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath); let response = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Unbounded IPC connection.')); }, timeout);
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(payload));
    socket.on('data', data => { response += data; });
    socket.on('error', error => { if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE') { clearTimeout(timer); reject(error); } });
    socket.once('close', () => { clearTimeout(timer); resolve(response); });
  });
}

test('daemon rejects oversized and malformed input, closes partial frames, and remains usable', { timeout: 12000 }, async t => {
  const home = homeFor(t); const stub = path.join(home, 'tmux.mjs');
  fs.writeFileSync(stub, `#!${process.execPath}\nconst command=process.argv[4];if(!['list-panes','list-clients'].includes(command))process.exit(1);\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ executables: { tmux: stub } }), { mode: 0o600 });
  const config = configuration({ ...process.env, HARBOR_HOME: home });
  const daemonPath = fileURLToPath(new URL('../../broker/daemon.mjs', import.meta.url));
  const child = spawn(process.execPath, [daemonPath], { env: { ...process.env, HARBOR_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = ''; child.stderr.on('data', bytes => { log += bytes.toString(); });
  try {
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(config.socket) && Date.now() < deadline && child.exitCode === null) await delay(20);
    assert.ok(fs.existsSync(config.socket), `Isolated daemon did not start: ${log}`);
    const started = Date.now();
    const [oversized, malformed, partial] = await Promise.all([
      rawExchange(config.socket, 'x'.repeat(1024 * 1024 + 100)),
      rawExchange(config.socket, '{invalid json}\n'),
      rawExchange(config.socket, '{"id":"partial"'),
    ]);
    assert.equal(JSON.parse(oversized).error.code, 'REQUEST_TOO_LARGE');
    assert.equal(JSON.parse(malformed).ok, false);
    assert.equal(partial, '');
    assert.ok(Date.now() - started >= 4500 && Date.now() - started < 7000, 'Partial frame idle timeout must be bounded.');
    const result = await rpc('list', { compact: true }, { config, autoStart: false, timeoutMs: 1000 });
    assert.deepEqual(result.sessions, []);
    assert.equal(fs.statSync(config.socket).mode & 0o777, 0o600);
    assert.equal(fs.statSync(config.home).mode & 0o777, 0o700);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
  }
});
