import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { configuration, executable } from '../../broker/common.mjs';
import { Tmux } from '../../broker/tmux.mjs';

let binary;
try { binary = executable('tmux', { env: process.env, executables: {}, home: os.tmpdir() }); } catch {}
test('an attached real PTY client becomes writable for the human and read-only for the bot', { skip: !binary || process.platform !== 'darwin', timeout: 10000 }, async () => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'harbor-pty-'));
  const config = configuration({ ...process.env, HARBOR_HOME: home }); config.executables = { tmux: binary };
  const tmux = new Tmux(config); let child;
  try {
    const run = { id:'test-run', tmux_name:'harbor-control-test' };
    const launched = tmux.launch(run, { id:'test-session', project: home }, { binary:'/bin/cat', args:[] });
    run.pane_id = launched.paneId;
    const python = `import os,pty,select,sys
pid,fd=pty.fork()
if pid==0: os.execv(sys.argv[1],sys.argv[1:])
try:
 while True:
  ready,_,_=select.select([0,fd],[],[])
  for source in ready:
   data=os.read(source,65536)
   if not data: raise EOFError()
   os.write(fd if source==0 else 1,data)
except (OSError,EOFError): pass
`;
    child = spawn('python3', ['-c', python, binary, ...tmux.args(run, true)], { env:{ ...process.env, TERM:'xterm-256color' }, stdio:['pipe','pipe','pipe'] });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const deadline = Date.now() + 3000;
    while (!tmux.call(['list-clients','-F','#{client_name}']) && Date.now() < deadline) await delay(30);
    assert.match(tmux.call(['list-clients','-F','#{client_flags}']), /read-only/, output);
    assert.match(tmux.call(['list-clients','-F','#{client_flags}']), /ignore-size/);
    tmux.launch({ id:'second-run', tmux_name:'harbor-other-session' }, { id:'second-session', project: home }, { binary:'/bin/cat', args:[] });
    tmux.enforce(run, 'human');
    assert.equal(tmux.call(['list-clients','-F','#{session_name}']), run.tmux_name);
    assert.doesNotMatch(tmux.call(['list-clients','-F','#{client_flags}']), /read-only/);
    assert.doesNotMatch(tmux.call(['list-clients','-F','#{client_flags}']), /ignore-size/);
    child.stdin.write('human owns this terminal\n');
    await delay(80);
    assert.match(tmux.capture(run), /human owns this terminal/);
    tmux.enforce(run, 'grok');
    assert.equal(tmux.call(['list-clients','-F','#{session_name}']), run.tmux_name);
    assert.match(tmux.call(['list-clients','-F','#{client_flags}']), /read-only/);
    assert.match(tmux.call(['list-clients','-F','#{client_flags}']), /ignore-size/);
    child.stdin.write('bot-owned input must not arrive\n');
    await delay(80);
    assert.doesNotMatch(tmux.capture(run), /bot-owned input must not arrive/);
    tmux.enforce(run, 'human');
    assert.equal(tmux.call(['list-clients','-F','#{session_name}']), run.tmux_name);
    assert.doesNotMatch(tmux.call(['list-clients','-F','#{client_flags}']), /read-only/);
  } finally { try { tmux.call(['kill-server']); } catch {} child?.kill('SIGTERM'); await delay(100); fs.rmSync(home, { recursive:true, force:true }); }
});
