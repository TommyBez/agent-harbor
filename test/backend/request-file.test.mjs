import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCreateRequest } from '../../broker/request-file.mjs';

test('a private create request preserves a large Unicode prompt and literal CLI arguments without argv limits', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-request-'));
  try {
    const filename = path.join(home, 'request.json');
    const request = { id:'17e9acc9-14d3-4dc7-bf6f-5c6ecceeb754', requestId:'stable-first-turn', provider:'codex', project:'/private/project', title:'Large task', owner:'human', text:'Analizza 你好 🌊\n'.repeat(1000), cliArgs:['--model','model name','--add-dir','/path with spaces'] };
    fs.writeFileSync(filename, JSON.stringify(request), { mode:0o600 });
    assert.deepEqual(readCreateRequest(filename), request);
    assert.equal(fs.existsSync(filename), true, 'Retry input must remain available until the caller removes it.');
    fs.writeFileSync(filename, 'x'.repeat(128 * 1024 + 1));
    assert.throws(() => readCreateRequest(filename), { code:'REQUEST_FILE_INVALID' });
    fs.writeFileSync(filename, '{"provider":"codex","shell":"do not execute"}');
    assert.throws(() => readCreateRequest(filename), { code:'REQUEST_FILE_INVALID' });
    const link = path.join(home, 'link.json'); fs.symlinkSync(filename, link);
    assert.throws(() => readCreateRequest(link), { code:'REQUEST_FILE_INVALID' });
  } finally { fs.rmSync(home, { recursive:true, force:true }); }
});
