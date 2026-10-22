import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../../broker/store.mjs';
import { Service, taskTitle } from '../../broker/service.mjs';
import { configuration, hashPayload, hashPrompt } from '../../broker/common.mjs';
import { readCreateRequest } from '../../broker/request-file.mjs';
import { validateCliArgs } from '../../broker/arguments.mjs';

// The desktop form previews the same names: app/src/tests.zig checks main.taskTitle against this fixture.
const TITLE_CASES = JSON.parse(fs.readFileSync(new URL('../../app/src/fixtures/task-titles.json', import.meta.url), 'utf8')).cases;

test('a first task names the session: first meaningful line, collapsed, cut at a word, without image mentions', () => {
  for (const { text, title } of TITLE_CASES) {
    assert.equal(taskTitle(text), title, JSON.stringify(text));
    assert.ok(Array.from(taskTitle(text)).length <= 60);
  }
  assert.equal(taskTitle(undefined), '');
});

function harness() {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'harbor-titles-'));
  const project = path.join(home, 'shop'); fs.mkdirSync(project);
  const config = configuration({ ...process.env, HARBOR_HOME: home });
  config.executables = { codex: process.execPath, claude: process.execPath };
  fs.mkdirSync(path.join(home, 'runs'), { recursive: true });
  const store = new Store(config.database);
  const launches = [];
  // Launches are recorded instead of reaching tmux: the command shows the exact prompt the CLI would receive.
  const tmux = { panes: () => new Map(), syncOwnership() {}, launch(run, session, command) { launches.push(command); return { paneId: '%1', pid: 1 }; }, args: () => [], binary: 'tmux' };
  const service = new Service(config, store, tmux);
  return { home, project, store, service, launches, cleanup: () => { store.close(); fs.rmSync(home, { recursive: true, force: true }); } };
}

test('derived titles never change the delivered prompt or its payload hash, and record their source', async () => {
  const h = harness();
  try {
    const text = '[Image #1]\n\n  Fix the   login redirect loop\nthen add a regression test';
    const id = randomUUID();
    const created = await h.service.execute('create', { id, requestId: id, provider: 'claude', project: h.project, text });
    assert.equal(created.session.title, 'Fix the login redirect loop');
    assert.equal(created.session.titleSource, 'task');
    const request = h.store.request(id, id);
    assert.equal(request.payload_hash, hashPayload(text));
    assert.equal(request.prompt_hash, hashPrompt(text));
    assert.deepEqual(h.launches.at(-1).args.slice(-2), ['--', text]);
    // A retry derives the same name, so it is the same creation, not a conflict.
    const retry = await h.service.execute('create', { id, requestId: id, provider: 'claude', project: h.project, text });
    assert.equal(retry.duplicate, true);
    assert.equal(h.launches.length, 1);

    const named = await h.service.execute('create', { provider: 'codex', project: h.project, title: 'Checkout review', text: 'Review checkout' });
    assert.equal(named.session.title, 'Checkout review');
    assert.equal(named.session.titleSource, 'user');
    const bare = await h.service.execute('create', { provider: 'codex', project: h.project });
    assert.equal(bare.session.title, 'shop');
    assert.equal(bare.session.titleSource, 'folder');
    assert.equal(h.launches.length, 2, 'Without a task or start, create only records the session.');
    const images = await h.service.execute('create', { provider: 'codex', project: h.project, text: '[Image #1]' });
    assert.equal(images.session.title, 'shop', 'A task with nothing but image mentions falls back to the folder.');
    assert.equal(images.session.titleSource, 'folder');

    const renamed = await h.service.execute('rename', { id, title: 'Login loop' });
    assert.equal(renamed.session.title, 'Login loop');
    assert.equal(renamed.session.titleSource, 'user');
    await assert.rejects(h.service.execute('create', { provider: 'codex', project: h.project, start: 'yes' }), { code: 'INVALID_START' });
  } finally { h.cleanup(); }
});

test('start launches a session without a task, and the desktop list carries startup arguments only when set', async () => {
  const h = harness();
  try {
    const id = randomUUID();
    const started = await h.service.execute('create', { id, requestId: id, provider: 'claude', project: h.project, start: true, cliArgs: ['--model', 'opus', '--effort', 'high'] });
    assert.equal(started.session.title, 'shop');
    assert.equal(h.launches.length, 1);
    const prompt = h.launches[0].args.at(-1);
    assert.match(prompt, /Reply only READY/);
    assert.equal(h.store.request(id, id).payload_hash, hashPayload(prompt));
    assert.equal((await h.service.execute('create', { id, requestId: id, provider: 'claude', project: h.project, start: true, cliArgs: ['--model', 'opus', '--effort', 'high'] })).duplicate, true);
    await h.service.execute('create', { provider: 'codex', project: h.project });
    const compact = await h.service.execute('list', { compact: true });
    assert.deepEqual(compact.sessions.find(s => s.id === id).cliArgs, ['--model', 'opus', '--effort', 'high']);
    assert.equal('cliArgs' in compact.sessions.find(s => s.id !== id), false);
    assert.equal('titleSource' in compact.sessions[0], false);
  } finally { h.cleanup(); }
});

test('request files accept start for the desktop form', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-request-'));
  try {
    const file = path.join(directory, 'create.json');
    fs.writeFileSync(file, JSON.stringify({ id: randomUUID(), provider: 'codex', project: '/tmp', start: true }), { mode: 0o600 });
    assert.equal(readCreateRequest(file).start, true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('every option the desktop form compiles passes the startup-argument allowlist unchanged', () => {
  // Model, Effort and Worktree as app/src/main.zig structuredArgs writes them, for every level the form offers.
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const args = ['--model', 'opus', '--effort', level, '--worktree', '--add-dir', '/work/shared'];
    assert.deepEqual(validateCliArgs('claude', args), args);
  }
  for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh']) {
    const args = ['--model', 'gpt-5.2', '-c', `model_reasoning_effort="${level}"`, '--worktree', '--search'];
    assert.deepEqual(validateCliArgs('codex', args), args);
  }
});
