import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Store } from '../../broker/store.mjs';
import { Service } from '../../broker/service.mjs';
import { launchCommand } from '../../broker/providers.mjs';
import { acceptEvent } from '../../broker/events.mjs';
import { configuration } from '../../broker/common.mjs';
import { validateCliArgs } from '../../broker/arguments.mjs';

test('startup options persist literally and resume preserves them without recreating a worktree', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-args-'));
  let store;
  try {
    const config = configuration({ ...process.env, HARBOR_HOME: home });
    config.executables = { codex: process.execPath, claude: process.execPath };
    store = new Store(config.database);
    const service = new Service(config, store, { panes: () => new Map(), syncOwnership() {} });
    for (const provider of ['claude', 'codex']) {
      const cliArgs = ['--model', 'literal model', '--add-dir', '/directory with spaces', '--worktree'];
      const created = await service.execute('create', { provider, project: home, title: provider, cliArgs });
      assert.deepEqual(created.session.cliArgs, cliArgs);
      const saved = store.session(created.session.id);
      const command = launchCommand({ ...saved, native_id: randomUUID() }, config, 'Initial task');
      assert.deepEqual(command.args.slice(0, cliArgs.length), cliArgs);
      const resumed = launchCommand({ ...saved, native_id: randomUUID(), resuming: true, working_directory: '/original worktree' }, config, 'Continue');
      assert.deepEqual(resumed.args.slice(0, cliArgs.length - 1), cliArgs.slice(0, -1));
      assert.equal(resumed.args.includes('--worktree'), false);
      assert.equal(resumed.args.at(-1), 'Continue');
    }
    store.close(); store = new Store(config.database);
    assert.deepEqual(JSON.parse(store.get('SELECT cli_args FROM sessions LIMIT 1').cli_args).slice(0, 2), ['--model', 'literal model']);
    for (const [provider, args] of [['claude',['--print']], ['claude',['--settings','other.json']], ['claude',['--resume','wrong']], ['codex',['--remote','ws://host']], ['codex',['--config','hooks . Stop=[]']], ['codex',['--dangerously-bypass-hook-trust']], ['claude',['--permission-mode','bypassPermissions']], ['codex',['--sandbox','danger-full-access']]]) assert.throws(() => validateCliArgs(provider, args), { code: 'RESERVED_CLI_ARGUMENT' });
    assert.throws(() => validateCliArgs('codex', ['--search', 'exec']), { code: 'UNSUPPORTED_CLI_ARGUMENT' });
    assert.deepEqual(validateCliArgs('codex', ['--config','model_reasoning_effort="high"']), ['--config','model_reasoning_effort="high"']);
  } finally { store?.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('a managed worktree is accepted only when Git identifies the same repository', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-worktree-'));
  let store;
  try {
    const project = path.join(home, 'project'), worktree = path.join(home, 'tree'), foreign = path.join(home, 'foreign');
    fs.mkdirSync(project); fs.mkdirSync(foreign);
    const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
    git(project, ['init']); git(project, ['-c','user.name=Harbor Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','fixture']);
    git(project, ['worktree','add','--detach',worktree]); git(foreign, ['init']);
    store = new Store(path.join(home, 'state.sqlite'));
    const id = randomUUID(), runId = randomUUID(), nativeId = randomUUID();
    store.run('INSERT INTO sessions(id,title,provider,project,cli_args,owner,status,run_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id,'Worktree','codex',project,'["--worktree"]','grok','starting',runId,'now','now');
    store.run('INSERT INTO runs(id,session_id,tmux_name,started_at) VALUES(?,?,?,?)', runId,id,'test','now');
    const run = store.runRecord(runId);
    acceptEvent(store, run, { sessionId:id, runId, provider:'codex', event:{ hook_event_name:'SessionStart', session_id:nativeId, cwd:worktree } },0);
    assert.equal(store.session(id).working_directory, fs.realpathSync(worktree));
    acceptEvent(store, run, { sessionId:id, runId, provider:'codex', event:{ hook_event_name:'SessionStart', session_id:nativeId, cwd:foreign } },100);
    assert.equal(store.session(id).error,'HOOK_PROJECT_MISMATCH');
    assert.equal(store.session(id).working_directory, fs.realpathSync(worktree));
  } finally { store?.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('Codex startup options cannot disable the hooks needed to correlate requests and responses', () => {
  const disabling = [
    ['--disable', 'hooks'], ['--disable=hooks'], ['--disable', 'other,hooks'],
    ['-c', 'features.hooks=false'], ['-c=features.hooks=false'],
    ['--config=features.hooks=false'], ['--config', 'features . "hooks" = false'],
    ['-c', "'features'.'hooks'=false"],
    ['-c', '"features"."h\\u006foks"=false'], ['-c', 'features."h\\U0000006foks"=false'],
    ['-c', 'features={hooks=false}'], ['--config=features = { "hooks" = false, other = true }'],
    ['--enable', 'hooks', '--disable', 'hooks'],
  ];
  for (const args of disabling) assert.throws(() => validateCliArgs('codex', args), { code: 'RESERVED_CLI_ARGUMENT' }, JSON.stringify(args));
  const compatible = ['--enable', 'hooks', '--disable', 'other', '-c', 'features.other=false', '--config', 'model_reasoning_effort="high"'];
  assert.deepEqual(validateCliArgs('codex', compatible), compatible, 'Unrelated feature and model settings must remain available.');
});
