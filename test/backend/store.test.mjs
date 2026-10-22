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
    assert.equal(migrated.get('PRAGMA user_version').user_version, 6);
    assert.equal(migrated.get('SELECT title_source FROM sessions').title_source, 'user');
    assert.equal(migrated.get('SELECT images_json FROM requests').images_json, '[]');
    assert.equal(migrated.get('SELECT title FROM sessions').title, 'Preserve this');
    assert.equal(migrated.get('SELECT control_epoch FROM sessions').control_epoch, 0);
    assert.equal(migrated.get('SELECT payload_hash FROM requests').payload_hash, 'legacy-hash');
    const runColumns = migrated.all('PRAGMA table_info(runs)').map(column => column.name);
    for (const name of ['pane_id', 'purpose', 'trust', 'trust_folder']) assert.ok(runColumns.includes(name), name);
    migrated.close();
    // A version-5 registry: a title equal to its folder name was the default, any other may be a person's choice.
    const five = path.join(dir, 'five.sqlite');
    const fresh = new Store(five);
    fresh.db.exec("PRAGMA user_version=5");
    fresh.close();
    const legacy = new DatabaseSync(five);
    legacy.exec(`ALTER TABLE sessions DROP COLUMN title_source; PRAGMA user_version=5;
      INSERT INTO sessions(id,title,provider,project,owner,status,created_at,updated_at) VALUES('default','shop','codex','/work/shop','human','stopped','t','t'),('named','Checkout review','claude','/work/shop','human','stopped','t','t');`);
    legacy.close();
    const six = new Store(five);
    assert.equal(six.get('PRAGMA user_version').user_version, 6);
    assert.deepEqual(six.all('SELECT id, title, title_source FROM sessions ORDER BY id').map(row => ({ ...row })), [
      { id: 'default', title: 'shop', title_source: 'folder' }, { id: 'named', title: 'Checkout review', title_source: 'user' }]);
    six.close();
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
