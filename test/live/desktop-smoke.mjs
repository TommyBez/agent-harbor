#!/usr/bin/env node
/** Real Native SDK UI smoke with fake providers in an EMPTY, dedicated HARBOR_HOME. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const view = 'main-canvas';
const usage = `Prepare: node test/live/desktop-smoke.mjs --prepare --home /private/tmp/harbor-ui-UNIQUE
Run: node test/live/desktop-smoke.mjs --run --home /private/tmp/harbor-ui-UNIQUE --cwd /private/tmp/harbor-ui-UNIQUE/desktop --native /absolute/path/to/native

Prepare first, then start the automation-enabled app with the printed HARBOR_HOME, then run.
--cwd is the app's automation working directory, containing .zig-cache/native-sdk-automation.
The runner requires an empty session registry and refuses the normal application home.
It leaves 26 stopped metadata sessions and private evidence under HOME/desktop-smoke.
One fake interactive provider starts and stops through the real UI. No AI provider starts.
No trust prompt is accepted, and no existing data is deleted.
Use a fresh dedicated home for each run. The app must be visible in an unlocked GUI session.`;

export function parseOptions(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const modes = argv.filter(value => value === '--prepare' || value === '--run');
  if (modes.length !== 1) throw new Error(usage);
  const options = { mode: modes[0].slice(2) };
  argv = argv.filter(value => value !== modes[0]);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!['home', 'cwd', 'native'].includes(key) || options[key] || !argv[i + 1] || !path.isAbsolute(argv[i + 1])) throw new Error(usage);
    options[key] = path.resolve(argv[i + 1]);
  }
  if (!options.home || (options.mode === 'run' && (!options.cwd || !options.native))) throw new Error(usage);
  const normalHome = path.join(os.homedir(), 'Library/Application Support/Agent Harbor');
  const real = p => { try { return fs.realpathSync(p); } catch { return p; } };
  if (real(options.home) === real(normalHome) || real(options.home) === real(os.homedir()) || options.home === '/') throw new Error('Refusing the normal application home. Supply a dedicated empty test home.');
  return options;
}

const digest = text => createHash('sha256').update(text).digest('hex');
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const markerName = 'desktop-smoke-prepared.json';

export function prepareHome(options) {
  if (fs.existsSync(options.home)) assert.equal(fs.readdirSync(options.home).length, 0, 'Prepare requires a new or completely empty directory.');
  assert(Buffer.byteLength(path.join(options.home, 'daemon.sock')) <= 100, 'Use a shorter dedicated home for the Unix socket.');
  fs.mkdirSync(options.home, { recursive: true, mode: 0o700 });
  fs.chmodSync(options.home, 0o700);
  const fixture = path.join(repository, 'test/backend/fake-cli.mjs');
  fs.accessSync(fixture, fs.constants.R_OK);
  const wrapper = path.join(options.home, 'fake-provider');
  const source = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixture)} "$@"\n`;
  fs.writeFileSync(wrapper, source, { mode: 0o700, flag: 'wx' });
  const configuration = { executables: { codex: wrapper, claude: wrapper } };
  fs.writeFileSync(path.join(options.home, 'config.json'), JSON.stringify(configuration, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(path.join(options.home, markerName), JSON.stringify({ schema: 1, home: fs.realpathSync(options.home), wrapper, wrapperHash: digest(source), fixture, fixtureHash: digest(fs.readFileSync(fixture)) }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return { ok: true, prepared: options.home, next: 'Start the automation-enabled app with this HARBOR_HOME, then invoke --run with --cwd and --native.', realProviderLaunches: 0 };
}

// IDs are 64-bit unsigned decimal strings. Never pass them through Number.
export function parseWidgets(snapshot) {
  const widgets = [];
  for (const line of snapshot.split('\n')) {
    const match = /^\s*widget @[^/]+\/([^#]+)#(\d+) role=(\S+) name=("(?:[^"\\]|\\.)*")/.exec(line);
    if (!match) continue;
    const quoted = key => { const found = new RegExp(`(?:^| )${key}=("(?:[^"\\\\]|\\\\.)*")`).exec(line); return found ? JSON.parse(found[1]) : null; };
    widgets.push({ view: match[1], id: match[2], role: match[3], name: JSON.parse(match[4]), placeholder: quoted('placeholder'), enabled: /\benabled=true\b/.test(line), selected: /state=\[[^\]]*\bselected\b/.test(line), line });
  }
  return widgets;
}

export function findWidget(snapshot, criteria) {
  const candidates = parseWidgets(snapshot).filter(widget => widget.view === view && Object.entries(criteria).every(([key, expected]) => widget[key] === expected));
  assert.equal(candidates.length, 1, `Expected exactly one widget ${JSON.stringify(criteria)}; found ${candidates.length}.`);
  return candidates[0];
}

export async function runSmoke(options) {
  const env = { ...process.env, HARBOR_HOME: options.home };
  const automation = path.join(options.cwd, '.zig-cache/native-sdk-automation');
  const snapshotPath = path.join(automation, 'snapshot.txt');
  fs.accessSync(options.native, fs.constants.X_OK);
  assert(fs.statSync(options.home).isDirectory(), 'Start the app in the dedicated home first.');
  assert(fs.statSync(automation).isDirectory(), 'The supplied cwd must contain the running app automation directory.');
  const prepared = JSON.parse(fs.readFileSync(path.join(options.home, markerName), 'utf8'));
  assert.equal(prepared.home, fs.realpathSync(options.home), 'Preparation marker belongs to another home.');
  assert.equal(digest(fs.readFileSync(prepared.wrapper)), prepared.wrapperHash, 'Prepared fake wrapper changed.');
  assert.equal(digest(fs.readFileSync(prepared.fixture)), prepared.fixtureHash, 'Fake provider source changed; prepare a fresh home.');
  const configured = JSON.parse(fs.readFileSync(path.join(options.home, 'config.json'), 'utf8'));
  assert.equal(configured.executables.codex, prepared.wrapper);
  assert.equal(configured.executables.claude, prepared.wrapper);
  const evidence = path.join(options.home, 'desktop-smoke');
  assert(!fs.existsSync(evidence), 'Evidence already exists. Use a fresh dedicated home for each run.');
  fs.mkdirSync(evidence, { mode: 0o700 });
  const report = { schema: 1, status: 'running', startedAt: new Date().toISOString(), checks: [], realProviderLaunches: 0, fakeProviderLaunches: 0, evidence: [] };
  const reportPath = path.join(evidence, 'report.json');
  let latest = '';
  let publisher = null;
  const write = (name, value) => { fs.writeFileSync(path.join(evidence, name), value, { mode: 0o600 }); if (!report.evidence.includes(name)) report.evidence.push(name); };
  const saveReport = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const check = name => { report.checks.push({ name, passed: true, at: new Date().toISOString() }); saveReport(); };
  const cli = async (...args) => {
    const { stdout } = await execute(process.execPath, [path.join(repository, 'bin/harbor.mjs'), ...args], { env, timeout: 25_000, maxBuffer: 8 * 1024 * 1024 });
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true, `Broker command failed: ${result.error?.code || args[0]}`);
    return result;
  };
  const native = async (...args) => execute(options.native, ['automate', ...args], { cwd: options.cwd, env, timeout: 35_000, maxBuffer: 8 * 1024 * 1024 });
  const snapshot = async () => {
    await native('snapshot');
    latest = fs.readFileSync(snapshotPath, 'utf8');
    assert.match(latest, /^ready=true /);
    assert.match(latest, /window @[^ ]+ "Agent Harbor"/);
    assert.match(latest.split('\n')[0], /\bdispatch_errors=0\b/);
    const pid = /\bpublisher_pid=(\d+)/.exec(latest)?.[1];
    assert(pid, 'Snapshot must identify the publishing app.');
    if (publisher !== null) assert.equal(pid, publisher, 'The automation publisher changed during the test.');
    publisher = pid;
    return latest;
  };
  const until = async (description, predicate, timeout = 20_000) => {
    const deadline = Date.now() + timeout;
    do { const text = await snapshot(); if (predicate(text)) return text; await delay(100); } while (Date.now() < deadline);
    throw new Error(`UI timed out: ${description}`);
  };
  const has = (text, criteria) => parseWidgets(text).some(w => w.view === view && Object.entries(criteria).every(([key, value]) => w[key] === value));
  const button = (text, name, enabled) => has(text, { role: 'button', name, enabled });
  const click = async criteria => { const widget = findWidget(await snapshot(), criteria); assert.equal(widget.enabled, true, `Cannot click disabled ${widget.name}`); await native('widget-click', view, widget.id); };
  const fill = async (placeholder, value) => { const widget = findWidget(await snapshot(), { role: 'textbox', placeholder }); await native('widget-action', view, widget.id, 'set_text', value); };
  const capture = async name => {
    write(`${name}.txt`, await snapshot());
    await native('screenshot', view);
    const target = path.join(evidence, `${name}.png`);
    fs.copyFileSync(path.join(automation, `screenshot-${view}.png`), target);
    fs.chmodSync(target, 0o600);
    assert(fs.statSync(target).size > 100, 'Screenshot artifact is empty.');
    report.evidence.push(`${name}.png`);
    saveReport();
  };
  const readback = async predicate => {
    const deadline = Date.now() + 20_000;
    do { const { sessions } = await cli('list', '--include-archived'); if (predicate(sessions)) return sessions; await delay(150); } while (Date.now() < deadline);
    throw new Error('Broker readback did not confirm the UI action.');
  };
  try {
    const doctor = await cli('doctor');
    for (const provider of ['codex', 'claude']) assert.equal(doctor.dependencies[provider]?.path, prepared.wrapper, 'The running daemon must use the prepared fake provider, never the installed AI CLI.');
    const initial = await cli('list', '--include-archived');
    assert.equal(initial.sessions.length, 0, 'The dedicated home must have an empty registry. Existing sessions are never modified.');
    await native('wait');
    await snapshot();
    const tag = randomUUID().slice(0, 8);
    const prefix = `Desktop smoke ${tag}`;
    const project = path.join(options.home, 'desktop-smoke-project');
    fs.mkdirSync(project, { mode: 0o700 });
    fs.writeFileSync(path.join(project, 'README.md'), '# Desktop UI fixture\nOnly the prepared fake provider may run in this test.\n', { mode: 0o600 });
    const seeded = [];
    for (let index = 1; index <= 25; index++) {
      const item = { id: randomUUID(), title: `${prefix} ${String(index).padStart(2, '0')}`, owner: index === 1 ? 'grok' : 'human' };
      await cli('create', '--id', item.id, '--provider', index % 2 ? 'codex' : 'claude', '--project', project, '--title', item.title, '--owner', item.owner);
      seeded.push(item);
    }
    report.seedIds = seeded.map(item => item.id);
    // A unique backend-generated marker must appear before any widget interaction.
    // This protects a simultaneously running personal app from an incorrect --cwd.
    await until('dedicated registry visible in the selected app', text => text.includes(prefix) && text.includes('25 sessioni · pagina 1/2') && text.includes('Gestore connesso'));
    check('Running UI is connected to the dedicated 25-session registry');
    const rows = text => parseWidgets(text).filter(w => w.role === 'listitem' && w.name.startsWith(prefix));
    const first = await until('first page and enabled attributes', text => rows(text).length === 20 && button(text, 'Pagina precedente', false) && button(text, 'Pagina successiva', true));
    const firstNames = rows(first).map(w => w.name);
    await click({ role: 'button', name: 'Pagina successiva' });
    const second = await until('second page', text => text.includes('25 sessioni · pagina 2/2') && rows(text).length === 5 && button(text, 'Pagina precedente', true) && button(text, 'Pagina successiva', false));
    assert.equal(new Set([...firstNames, ...rows(second).map(w => w.name)]).size, 25, 'Pagination must expose 25 distinct backend titles.');
    assert.deepEqual([...firstNames, ...rows(second).map(w => w.name)].sort(), seeded.map(s => s.title).sort());
    await capture('01-pagination');
    check('Both pages expose all 25 exact names and correct disabled navigation');
    await click({ role: 'button', name: 'Pagina precedente' });
    await until('first page restored', text => text.includes('25 sessioni · pagina 1/2'));

    const bot = seeded[0];
    await fill('Cerca sessione o progetto', bot.title);
    await until('search finds a session from outside the first page', text => rows(text).length === 1 && has(text, { role: 'listitem', name: bot.title }) && text.includes('1 sessioni · pagina 1/1'));
    await click({ role: 'listitem', name: bot.title });
    await until('Grok ownership disables resume', text => button(text, 'Riprendi sessione', false) && button(text, 'Prendi il controllo', true));
    await capture('02-search-and-disabled-resume');
    check('Search selects the exact Grok-owned session; resume is disabled');
    await fill('Cerca sessione o progetto', '');
    await until('search cleared', text => text.includes('25 sessioni · pagina 1/2'));

    await click({ role: 'button', name: 'Nuova sessione' });
    await until('new session form', text => button(text, 'Crea e avvia', false) && has(text, { role: 'textbox', placeholder: 'Cosa deve fare l\'agente?' }));
    await fill('Percorso del progetto locale', '');
    const createdTitle = `${prefix} created`;
    await fill('Es. Revisione del checkout', createdTitle);
    await until('missing project disables creation', text => button(text, 'Crea e avvia', false));
    await fill('Percorso del progetto locale', project);
    await fill('Cosa deve fare l\'agente?', '');
    await until('complete form enables creation', text => button(text, 'Crea e avvia', true));
    await capture('03-new-session-empty-prompt');
    await click({ role: 'button', name: 'Crea e avvia' });
    let sessions = await readback(items => items.length === 26 && items.some(item => item.title === createdTitle));
    const created = sessions.find(item => item.title === createdTitle);
    report.createdId = created.id;
    assert.equal(created.owner, 'human');
    assert.equal(created.project, project);
    await readback(items => { const item = items.find(item => item.id === created.id); return item?.alive && item.nativeSessionId && item.lastResponse?.startsWith('ANSWER:') && !item.pending; });
    report.fakeProviderLaunches = 1;
    await until('fake provider response and enabled stop button', text => button(text, 'Chiudi CLI', true) && has(text, { role: 'text', name: createdTitle }) && text.includes('Fake interactive codex') && text.includes('ANSWER:'));
    await capture('04-fake-provider-response');
    check('Form validation and an empty prompt launch the fake CLI and display its response');

    await click({ role: 'button', name: 'Rinomina sessione' });
    await until('rename field', text => has(text, { role: 'textbox', placeholder: 'Nuovo nome' }));
    const renamedTitle = `${prefix} renamed`;
    await fill('Nuovo nome', renamedTitle);
    await click({ role: 'button', name: 'Salva' });
    await readback(items => items.find(item => item.id === created.id)?.title === renamedTitle);
    await until('renamed title in UI', text => has(text, { role: 'listitem', name: renamedTitle }) && !has(text, { role: 'textbox', placeholder: 'Nuovo nome' }));
    check('UI rename is persisted on the same session ID');
    await click({ role: 'button', name: 'Chiudi CLI' });
    await readback(items => { const item = items.find(item => item.id === created.id); return item && !item.alive && item.status === 'stopped'; });
    await until('closed fake provider offers resume and archive', text => button(text, 'Riprendi sessione', true) && button(text, 'Archivia', true));
    check('UI closes the fake CLI normally and preserves its native conversation');
    await click({ role: 'button', name: 'Archivia' });
    await readback(items => items.find(item => item.id === created.id)?.status === 'archived');
    await until('archived session removed from all-sessions list', text => !has(text, { role: 'listitem', name: renamedTitle }));
    await click({ role: 'listitem', name: 'Archiviate' });
    await until('archive filter contains the session', text => has(text, { role: 'listitem', name: renamedTitle }));
    await click({ role: 'listitem', name: renamedTitle });
    await until('archive offers restore and no start', text => button(text, 'Ripristina dall\'archivio', true) && !has(text, { role: 'button', name: 'Riprendi sessione' }));
    await capture('05-archived');
    await click({ role: 'button', name: 'Ripristina dall\'archivio' });
    await readback(items => items.find(item => item.id === created.id)?.status === 'stopped');
    await until('archive view clears after restore', text => !has(text, { role: 'listitem', name: renamedTitle }));
    await click({ role: 'listitem', name: 'Tutte le sessioni · 26' });
    await until('restored session visible', text => has(text, { role: 'listitem', name: renamedTitle }) && text.includes('26 sessioni · pagina 1/2'));
    await click({ role: 'listitem', name: renamedTitle });
    await until('restored session can resume', text => button(text, 'Riprendi sessione', true));
    await capture('06-restored');
    check('UI archive and restore preserve identity and available actions');
    sessions = (await cli('list', '--include-archived')).sessions;
    assert.equal(sessions.length, 26);
    for (const session of sessions) {
      assert.equal(session.alive, false, `${session.title} unexpectedly alive`);
      assert.equal(session.status, 'stopped');
      if (session.id === created.id) { assert(session.runId); assert(session.nativeSessionId); }
      else { assert.equal(session.runId, null, `${session.title} unexpectedly started`); assert.equal(session.nativeSessionId, null); }
    }
    check('All 26 sessions are stopped; exactly one fake provider ran, and no seeded metadata started');
    report.status = 'passed';
    report.sessionCount = sessions.length;
    report.publisherPid = publisher;
    report.finishedAt = new Date().toISOString();
    saveReport();
    return { ok: true, report: reportPath, checks: report.checks.length, sessionCount: sessions.length, fakeProviderLaunches: 1, realProviderLaunches: 0 };
  } catch (error) {
    if (latest) write('failure-snapshot.txt', latest);
    report.status = 'failed'; report.error = error.message; report.finishedAt = new Date().toISOString(); saveReport();
    error.report = reportPath;
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) process.stdout.write(usage + '\n');
    else process.stdout.write(JSON.stringify(options.mode === 'prepare' ? prepareHome(options) : await runSmoke(options), null, 2) + '\n');
  } catch (error) { process.stderr.write(JSON.stringify({ ok: false, error: error.message, report: error.report }, null, 2) + '\n'); process.exitCode = 1; }
}
