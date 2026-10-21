import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { rpc } from '../../broker/client.mjs';
import { configuration, executable, loginShellPath, sessionPath } from '../../broker/common.mjs';

function fakeShell(dir, body) {
  const file = path.join(dir, 'shell');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  return file;
}

test('the login shell PATH is read between markers, ignoring rc-file noise, and never blocks', async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'harbor-shell-'));
  try {
    const noisy = fakeShell(dir, `echo "Welcome back"; printf '__HARBOR_PATH__/fake/bin:/usr/bin__HARBOR_PATH__'; echo trailing`);
    assert.equal(await loginShellPath({ SHELL: noisy, PATH: '/usr/bin' }), '/fake/bin:/usr/bin');
    const slow = fakeShell(dir, 'sleep 5');
    const started = Date.now();
    assert.equal(await loginShellPath({ SHELL: slow, PATH: '/usr/bin' }, 300), null);
    assert.ok(Date.now() - started < 3000);
    assert.equal(await loginShellPath({ SHELL: fakeShell(dir, 'exit 1'), PATH: '/usr/bin' }), null);
    const merged = sessionPath({ PATH: '/usr/bin:/bin:relative' }, '/fake/bin:/usr/bin').split(':');
    assert.equal(merged[0], '/fake/bin');
    assert.equal(merged.filter(dir => dir === '/usr/bin').length, 1);
    assert.ok(merged.includes('/opt/homebrew/bin'));
    assert.ok(!merged.includes('relative'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

let tmux = process.env.HARBOR_TEST_TMUX;
try { tmux ||= executable('tmux', { env: process.env, executables: {}, home: os.tmpdir() }); } catch {}
test('a launched CLI sees the login shell PATH', { skip: !tmux, timeout: 30000 }, async () => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'harbor-path-'));
  const fake = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ executables: { tmux, claude: fake, codex: fake } }));
  const project = path.join(home, 'project'); fs.mkdirSync(project);
  const shell = fakeShell(home, `printf '__HARBOR_PATH__/from/login/shell:${process.env.PATH}__HARBOR_PATH__'`);
  const config = configuration({ ...process.env, HARBOR_HOME: home, SHELL: shell });
  const previous = process.env.SHELL; process.env.SHELL = shell;
  try {
    const id = randomUUID();
    await rpc('create', { id, provider: 'claude', project, title: 'Path', owner: 'grok', text: 'PATH?', requestId: 'path-1' }, { config });
    const done = await rpc('wait', { id, requestId: 'path-1', timeout: 10000 }, { config });
    assert.equal(done.outcome, 'completed');
    assert.match(done.request.response, /^PATH:\/from\/login\/shell:/);
  } finally {
    process.env.SHELL = previous;
    try { process.kill(JSON.parse(fs.readFileSync(path.join(home, 'daemon.lock/owner.json'))).pid, 'SIGTERM'); } catch {}
    try { execFileSync(tmux, ['-S', config.tmuxSocket, 'kill-server'], { stdio: 'ignore' }); } catch {}
    await delay(100);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
