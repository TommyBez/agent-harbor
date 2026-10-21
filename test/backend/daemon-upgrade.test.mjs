import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { rpc } from '../../broker/client.mjs';
import { configuration, compareVersions, processAlive, VERSION } from '../../broker/common.mjs';

test('versions order numerically and a missing version sorts first', () => {
  assert.ok(compareVersions('0.1.10', '0.1.9') > 0);
  assert.ok(compareVersions('1.0.0', '0.9.9') > 0);
  assert.equal(compareVersions('0.1.2', '0.1.2'), 0);
  assert.ok(compareVersions('0.1.2', undefined) > 0);
  assert.ok(compareVersions('0.0.1', 'garbage') > 0);
});

// A controller from a release before 0.1.2: it answers doctor without a version and stops on SIGTERM.
const LEGACY = `import net from 'node:net'; import fs from 'node:fs';
const socket = process.argv[2];
const server = net.createServer(c => c.on('data', d => { const r = JSON.parse(String(d).split('\\n')[0]); c.end(JSON.stringify({ id: r.id, ok: true, daemonPid: process.pid, schemaVersion: 4 }) + '\\n'); }));
server.listen(socket, () => process.stdout.write('ready\\n'));
process.on('SIGTERM', () => { server.close(); try { fs.unlinkSync(socket); } catch {} process.exit(0); });`;

test('a client replaces a controller from an older release and keeps working', { timeout: 20000 }, async () => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'harbor-upgrade-'));
  const config = configuration({ ...process.env, HARBOR_HOME: home });
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, 'legacy.mjs'), LEGACY);
  const legacy = spawn(process.execPath, [path.join(home, 'legacy.mjs'), config.socket], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise(resolve => legacy.stdout.once('data', resolve));
    assert.equal((await rpc('doctor', {}, { config })).version, undefined, 'doctor alone never replaces the controller');
    const list = await rpc('list', {}, { config });
    assert.deepEqual(list.sessions, []);
    await delay(100);
    assert.equal(processAlive(legacy.pid), false, 'The old controller received its normal shutdown.');
    const doctor = await rpc('doctor', {}, { config });
    assert.equal(doctor.version, VERSION);
    assert.equal(doctor.schemaVersion, 5);
    await assert.rejects(rpc('shutdown', { version: VERSION }, { config, autoStart: false }), { code: 'DAEMON_NOT_OLDER' });
    await assert.rejects(rpc('shutdown', { version: '0.0.1' }, { config, autoStart: false }), { code: 'DAEMON_NOT_OLDER' });
    assert.equal((await rpc('shutdown', { version: '999.0.0' }, { config, autoStart: false })).version, VERSION);
    for (let attempt = 0; attempt < 50 && processAlive(doctor.daemonPid); attempt++) await delay(100);
    assert.equal(processAlive(doctor.daemonPid), false);
    assert.notEqual((await rpc('doctor', {}, { config })).daemonPid, doctor.daemonPid, 'The next call starts a fresh controller.');
  } finally {
    try { legacy.kill('SIGKILL'); } catch {}
    try { process.kill(JSON.parse(fs.readFileSync(path.join(home, 'daemon.lock/owner.json'))).pid, 'SIGTERM'); } catch {}
    try { execFileSync('tmux', ['-S', config.tmuxSocket, 'kill-server'], { stdio: 'ignore' }); } catch {}
    await delay(100);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
