import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { findWidget, parseOptions, parseWidgets, prepareHome } from '../live/desktop-smoke.mjs';

test('desktop smoke parses Native semantics without losing 64-bit widget IDs or escaped names', () => {
  const snapshot = `ready=true protocol=0x1 publisher_pid=1 dispatch_errors=0
    widget @w1/main-canvas#18446744073709551615 role=button name="Pagina successiva" bounds=(264,792.75 32x32) focused=false enabled=false state=[disabled]
    widget @w1/main-canvas#9007199254740993 role=listitem name="Smoke \\"quoted\\"" bounds=(14,300 282x80) focused=false enabled=true state=[selected] actions=[press]
    widget @w1/main-canvas#11843511342448992222 role=textbox name="" bounds=(14,79 282x32) focused=false enabled=true placeholder="Cerca sessione o progetto" actions=[focus,set_text]
    widget @w1/other-view#12 role=button name="Pagina successiva" bounds=(0,0 10x10) enabled=true
`;
  const widgets = parseWidgets(snapshot);
  assert.equal(widgets.length, 4);
  assert.equal(findWidget(snapshot, { role: 'button', name: 'Pagina successiva' }).id, '18446744073709551615');
  assert.equal(findWidget(snapshot, { role: 'button', name: 'Pagina successiva' }).enabled, false);
  assert.equal(findWidget(snapshot, { role: 'listitem', name: 'Smoke "quoted"' }).selected, true);
  assert.equal(findWidget(snapshot, { role: 'textbox', placeholder: 'Cerca sessione o progetto' }).id, '11843511342448992222');
  assert.throws(() => findWidget(snapshot + snapshot, { role: 'button', name: 'Pagina successiva' }), /exactly one/);
});

test('desktop smoke requires explicit absolute paths and refuses the personal application home', () => {
  assert.throws(() => parseOptions([]), /Prepare:/);
  assert.throws(() => parseOptions(['--run', '--home', './test', '--cwd', '/tmp/app', '--native', '/tmp/native']), /Prepare:/);
  assert.throws(() => parseOptions(['--run', '--home', path.join(os.homedir(), 'Library/Application Support/Agent Harbor'), '--cwd', '/tmp/app', '--native', '/tmp/native']), /Refusing/);
  assert.throws(() => parseOptions(['--run', '--home', '/tmp/test', '--cwd', '/tmp/app', '--native', '/tmp/native', '--native', '/tmp/native']), /Prepare:/);
  assert.deepEqual(parseOptions(['--run', '--home', '/private/tmp/harbor-isolated', '--cwd', '/private/tmp/harbor-isolated/desktop', '--native', '/private/tmp/native']), { mode: 'run', home: '/private/tmp/harbor-isolated', cwd: '/private/tmp/harbor-isolated/desktop', native: '/private/tmp/native' });
  assert.deepEqual(parseOptions(['--prepare', '--home', '/private/tmp/harbor-isolated']), { mode: 'prepare', home: '/private/tmp/harbor-isolated' });
  assert.deepEqual(parseOptions(['--help']), { help: true });
});

test('desktop smoke preparation only configures private fake executables and refuses overwrite', () => {
  const home = fs.mkdtempSync('/tmp/harbor-smoke-unit-');
  try {
    const result = prepareHome({ home });
    assert.equal(result.realProviderLaunches, 0);
    assert.equal(fs.existsSync(path.join(home, 'harbor.sqlite')), false, 'Prepare must not launch the daemon.');
    const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.equal(config.executables.codex, path.join(home, 'fake-provider'));
    assert.equal(config.executables.claude, config.executables.codex);
    assert.equal(fs.statSync(path.join(home, 'config.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(config.executables.codex).mode & 0o777, 0o700);
    assert.match(fs.readFileSync(config.executables.codex, 'utf8'), /fake-cli\.mjs/);
    assert.throws(() => prepareHome({ home }), /completely empty/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
