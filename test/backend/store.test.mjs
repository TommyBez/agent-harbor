import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../broker/store.mjs';
import { hashPayload, hashPrompt, validateText } from '../../broker/common.mjs';

test('schema migrations preserve existing sessions and corruption never resets persisted data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-store-'));
  const filename = path.join(dir, 'state.sqlite');
  try {
    const old = new DatabaseSync(filename);
    old.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT); CREATE TABLE runs(id TEXT PRIMARY KEY); CREATE TABLE requests(prompt_hash TEXT); INSERT INTO sessions VALUES('saved','Preserve this'); INSERT INTO requests VALUES('legacy-hash'); PRAGMA user_version=1;`);
    old.close();
    const migrated = new Store(filename);
    assert.equal(migrated.get('PRAGMA user_version').user_version, 3);
    assert.equal(migrated.get('SELECT title FROM sessions').title, 'Preserve this');
    assert.equal(migrated.get('SELECT control_epoch FROM sessions').control_epoch, 0);
    assert.equal(migrated.get('SELECT payload_hash FROM requests').payload_hash, 'legacy-hash');
    assert.ok(migrated.all('PRAGMA table_info(runs)').some(column => column.name === 'pane_id'));
    migrated.close();
    const corrupt = path.join(dir, 'corrupt.sqlite');
    const bytes = Buffer.from('These bytes must never be replaced by an empty database.');
    fs.writeFileSync(corrupt, bytes);
    assert.throws(() => new Store(corrupt));
    assert.deepEqual(fs.readFileSync(corrupt), bytes);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('idempotency uses exact payload while hook matching tolerates native paste wrappers', () => {
  const text = 'Analizza più righe\n你好 🌊';
  assert.equal(validateText(text), text);
  assert.notEqual(hashPayload(text), hashPayload(text + ' '));
  assert.equal(hashPrompt(text), hashPrompt('<pasted_content>\n' + text + '\n</pasted_content>'));
  assert.throws(() => validateText('hello\x1b[31m'), { code: 'INVALID_TEXT' });
});
