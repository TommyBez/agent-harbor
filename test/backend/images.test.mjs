import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readImages, stageImages, imagePayloadHash, IMAGE_LIMITS } from '../../broker/images.mjs';
import { configuration, ensurePrivateHome } from '../../broker/common.mjs';
import { Store } from '../../broker/store.mjs';
import { Service } from '../../broker/service.mjs';
import { Tmux, codexComposerImages } from '../../broker/tmux.mjs';
import { acceptEvent } from '../../broker/events.mjs';
import { readRequest } from '../../broker/request-file.mjs';

const fixture = fs.readFileSync(new URL('../../docs/images/image-paste-challenge.png', import.meta.url));
function environment() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor images '));
  const config = configuration({ ...process.env, HARBOR_HOME: home });
  config.executables = { codex: process.execPath, claude: process.execPath };
  ensurePrivateHome(config);
  const image = path.join(home, 'input with spaces.png'); fs.writeFileSync(image, fixture);
  return { home, config, image, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test('image bytes are bounded, validated, immutable and private; request identity includes content and order', () => {
  const e = environment();
  try {
    const input = readImages([e.image]);
    const staged = stageImages(e.config, input);
    assert.equal(staged[0].mimeType, 'image/png');
    assert.equal(fs.statSync(path.dirname(staged[0].storedPath)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(staged[0].storedPath).mode & 0o777, 0o600);
    assert.deepEqual(stageImages(e.config, input), staged);
    const changed = Buffer.from(fixture); changed[changed.length - 1] ^= 1;
    fs.writeFileSync(e.image, changed);
    assert.deepEqual(fs.readFileSync(staged[0].storedPath), fixture, 'Delivery must keep the captured bytes after source mutation.');
    const next = readImages([e.image]);
    assert.notEqual(imagePayloadHash('same prompt', input), imagePayloadHash('same prompt', next));
    assert.notEqual(imagePayloadHash('same prompt', [...input,...next]), imagePayloadHash('same prompt', [...next,...input]));
    assert.notEqual(imagePayloadHash('same prompt', input), imagePayloadHash('same prompt ', input));
    fs.writeFileSync(staged[0].storedPath, changed);
    assert.throws(() => stageImages(e.config, input), { code: 'ATTACHMENT_CORRUPT' });
    assert.throws(() => readImages(['relative.png']), { code: 'INVALID_IMAGE_PATH' });
    assert.throws(() => readImages(['https://example.invalid/image.png']), { code: 'INVALID_IMAGE_PATH' });
    assert.throws(() => readImages([e.image + '\n']), { code: 'INVALID_IMAGE_PATH' });
    assert.throws(() => readImages(Array(9).fill(e.image)), { code: 'INVALID_IMAGES' });
    assert.throws(() => readImages([e.home]), { code: 'INVALID_IMAGE' });
    const link = path.join(e.home, 'link.png'); fs.symlinkSync(e.image, link);
    assert.throws(() => readImages([link]), { code: 'IMAGE_UNREADABLE' });
    fs.writeFileSync(e.image, 'not a PNG');
    assert.throws(() => readImages([e.image]), { code: 'INVALID_IMAGE' });
    fs.truncateSync(e.image, IMAGE_LIMITS.bytes + 1);
    assert.throws(() => readImages([e.image]), { code: 'INVALID_IMAGE' });
    fs.writeFileSync(e.image, Buffer.concat([fixture, Buffer.alloc(IMAGE_LIMITS.bytes - fixture.length)]));
    assert.throws(() => readImages(Array(4).fill(e.image)), { code: 'IMAGES_TOO_LARGE' });
  } finally { e.cleanup(); }
});

class TerminalFixture {
  active = new Map(); launches = []; pastes = []; enters = []; attachmentPastes = [];
  panes() { return this.active; }
  args() { return []; }
  syncOwnership() {} enforce() {}
  launch(run, session, command) {
    this.launches.push({ run, session, command });
    const paneId = '%' + this.launches.length;
    this.active.set(paneId, { id: paneId, pid: 100 + this.launches.length, name: run.tmux_name, windowIndex: 0, paneIndex: 0, alive: true });
    return { paneId, pid: 100 + this.launches.length };
  }
  paste(run, text) { this.pastes.push({ pane: run.pane_id, text }); }
  async pasteImages(run, images, check) { check(); this.attachmentPastes.push({ pane: run.pane_id, images }); this.onAttachment?.(); check(); }
  enter(run) { this.enters.push(run.pane_id); }
  capture() { return ''; }
}
function event(store, id, event, offset) {
  const s = store.session(id), run = store.runRecord(s.run_id);
  acceptEvent(store, run, { sessionId: id, runId: run.id, provider: s.provider, event: { cwd: s.project, session_id: s.native_id || randomUUID(), ...event } }, offset);
}

test('image requests preserve exact conversation, receipts and ownership across creation, send and resume', async () => {
  const e = environment(); const store = new Store(e.config.database); const terminal = new TerminalFixture(); const service = new Service(e.config, store, terminal);
  try {
    for (const provider of ['claude','codex']) {
      const args = { provider, project: e.home, owner: 'grok', text: 'Describe this.', images: [e.image], requestId: 'first' };
      const first = await service.execute('create', args); const id = first.session.id;
      const command = terminal.launches.at(-1).command.args;
      const attachment = first.request.images[0];
      assert.equal(first.request.transport, 'cli-initial-images');
      if (provider === 'codex') assert.equal(command[command.indexOf('--image') + 1], attachment.storedPath);
      else assert.match(command.at(-1), /^@".*harbor images .*\.png"\n\nDescribe this\.$/);
      event(store,id,{hook_event_name:'SessionStart'},0);
      const nativeId = store.session(id).native_id;
      const key = provider === 'codex' ? 'turn_id' : 'prompt_id';
      const prompt = provider === 'codex' ? '[Image #1] Describe this.' : command.at(-1);
      event(store,id,{hook_event_name:'UserPromptSubmit',[key]:'first-turn',prompt},1);
      event(store,id,{hook_event_name:'Stop',[key]:'first-turn',last_assistant_message:'visual answer'},2);
      assert.equal(service.request(id,'first').response,'visual answer');
      const duplicate = await service.execute('send',{id,actor:'grok',...args});
      assert.equal(duplicate.duplicate,true); assert.equal(terminal.enters.length,provider === 'claude' ? 0 : 1);
      const changed = Buffer.from(fixture); changed[changed.length - 1] ^= 1; fs.writeFileSync(e.image,changed);
      await assert.rejects(service.execute('send',{id,actor:'grok',...args}),{code:'REQUEST_ID_CONFLICT'});
      fs.writeFileSync(e.image,fixture);
      await service.execute('control',{id,owner:'human'});
      await assert.rejects(service.execute('send',{id,actor:'grok',text:'blocked',images:[e.image],requestId:'blocked'}),{code:'CONTROL_DENIED'});
      assert.equal(store.request(id,'blocked'),undefined);
      await service.execute('control',{id,owner:'grok'});
      const sent = await service.execute('send',{id,actor:'grok',text:'Compare again.',images:[e.image],requestId:'next'});
      const expected = provider === 'codex' ? '[Image #1] Compare again.' : terminal.pastes.at(-1).text;
      event(store,id,{hook_event_name:'UserPromptSubmit',[key]:'next-turn',prompt:expected},3);
      event(store,id,{hook_event_name:'Stop',[key]:'next-turn',last_assistant_message:'second visual answer'},4);
      assert.equal(service.request(id,'next').response,'second visual answer');
      assert.equal(sent.session.nativeSessionId,nativeId);
      store.run("UPDATE requests SET status='uncertain',accepted_at=NULL WHERE session_id=? AND request_id='next'",id);
      await assert.rejects(service.execute('send',{id,actor:'grok',text:'Compare again.',images:[e.image],requestId:'ambiguous'}),{code:'REQUEST_UNRESOLVED'});
      assert.equal(store.request(id,'ambiguous'),undefined,'An uncorrelated earlier image turn cannot be attributed to a new receipt.');
      store.run("UPDATE requests SET status='completed' WHERE session_id=? AND request_id='next'",id);
      const oldRun = store.runRecord(store.session(id).run_id); terminal.active.delete(oldRun.pane_id); service.refresh();
      const resumed = await service.execute('resume',{id,actor:'grok',text:'Continue.',images:[e.image],requestId:'resume'});
      assert.equal(resumed.session.nativeSessionId,nativeId);
      assert.notEqual(resumed.session.runId,oldRun.id);
      const resumeArgs = terminal.launches.at(-1).command.args;
      assert.equal(resumeArgs[resumeArgs.indexOf(provider === 'codex' ? 'resume' : '--resume') + 1],nativeId);
      assert.equal(resumed.request.images[0].sha256,attachment.sha256);
    }
    assert.equal(terminal.attachmentPastes.length,1,'Only Codex live send pastes image paths into the native composer.');
  } finally { store.close(); e.cleanup(); }
});

test('ownership change while preparing images never submits Enter and leaves an uncertain receipt', async () => {
  const e=environment(); const store=new Store(e.config.database); const terminal=new TerminalFixture(); const service=new Service(e.config,store,terminal);
  try {
    const first=await service.execute('create',{provider:'codex',project:e.home,owner:'grok',text:'Ready',requestId:'initial'}); const id=first.session.id;
    event(store,id,{hook_event_name:'UserPromptSubmit',turn_id:'initial-turn',prompt:'Ready'},0);
    event(store,id,{hook_event_name:'Stop',turn_id:'initial-turn',last_assistant_message:'ready'},1);
    terminal.onAttachment=()=>store.run("UPDATE sessions SET owner='human',control_epoch=control_epoch+1 WHERE id=?",id);
    await assert.rejects(service.execute('send',{id,actor:'grok',text:'Read image',images:[e.image],requestId:'takeover'}),{code:'CONTROL_DENIED'});
    assert.equal(terminal.enters.length,0);
    assert.equal(service.request(id,'takeover').status,'uncertain');
  } finally { store.close();e.cleanup(); }
});

test('image attachment preflight reads only the current Codex composer and checks each delivery', async () => {
  assert.deepEqual(codexComposerImages('› [Image #1] old\nanswer\n\n› Ask Codex to do anything\n\nfooter'),[]);
  assert.deepEqual(codexComposerImages('history\n› [Image #1] [Image #2]\n\nfooter'),[1,2]);
  assert.equal(codexComposerImages('permission dialog'),null);
  const pastes=[];let checks=0;
  const adapter={capture:()=>`› ${pastes.map((_,i)=>`[Image #${i+1}]`).join(' ')}\n\nfooter`,paste:(_,text)=>pastes.push(text)};
  await Tmux.prototype.pasteImages.call(adapter,{pane_id:'%2'},[{storedPath:'/path with spaces/a.png'},{storedPath:'/b.png'}],()=>checks++);
  assert.deepEqual(pastes,["'/path with spaces/a.png'","'/b.png'"]);
  assert.equal(checks,4);
  await assert.rejects(Tmux.prototype.pasteImages.call(adapter,{},[{storedPath:'/c.png'}],()=>{}),{code:'IMAGE_COMPOSER_NOT_READY'});
});

test('request JSON supports image turns without relaxing action-specific fields', () => {
  const e=environment();
  try {
    const file=path.join(e.home,'request.json'); const request={id:randomUUID(),actor:'grok',requestId:'visual',text:'Describe',images:[e.image]};
    fs.writeFileSync(file,JSON.stringify(request));
    for(const action of ['send','start','resume']) assert.deepEqual(readRequest(file,action),request);
    assert.throws(()=>readRequest(file,'create'),{code:'REQUEST_FILE_INVALID'});
    assert.throws(()=>readRequest(file,'stop'),{code:'REQUEST_FILE_INVALID'});
  } finally {e.cleanup();}
});
