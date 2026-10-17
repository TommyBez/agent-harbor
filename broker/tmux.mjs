import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { executable, fail, quote } from './common.mjs';

export function codexComposerImages(screen) {
  const lines = screen.split('\n');
  const start = lines.findLastIndex(line => /^\s*›(?:\s|$)/.test(line));
  if (start < 0) return null;
  const composer = [];
  for (const line of lines.slice(start)) {
    if (composer.length && !line.trim()) break;
    composer.push(line);
  }
  return [...composer.join('\n').matchAll(/\[Image #(\d+)\]/g)].map(match => Number(match[1]));
}

export class Tmux {
  constructor(config) { this.config = config; this.binary = executable('tmux', config); }
  call(args, options = {}) {
    try { return execFileSync(this.binary, ['-S', this.config.tmuxSocket, ...args], { encoding: 'utf8', timeout: 3000, maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options }).trimEnd(); }
    catch (error) { fail('TMUX_ERROR', String(error.stderr || error.message).trim()); }
  }
  panes() {
    try {
      const result = this.call(['list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}\t#{pane_dead}\t#{pane_id}\t#{pane_current_command}\t#{window_index}\t#{pane_index}']);
      return new Map(result.split('\n').filter(Boolean).map(line => { const [name, pid, dead, id, command, windowIndex, paneIndex] = line.split('\t'); return [id, { name, pid: Number(pid), alive: dead === '0', id, command, windowIndex: Number(windowIndex), paneIndex: Number(paneIndex) }]; }));
    } catch (error) {
      if (/no server running|error connecting.*No such file|no sessions/.test(error.message)) return new Map();
      throw error;
    }
  }
  launch(run, session, command) {
    const configPath = path.join(this.config.home, 'tmux.conf');
    fs.writeFileSync(configPath, 'set -g remain-on-exit on\nset -g status off\nset -g prefix None\nset -g history-limit 10000\nset -g destroy-unattached off\nset -g exit-empty off\nset -g default-terminal "xterm-256color"\nunbind-key -a\n', { mode: 0o600 });
    const result = this.call(['-f', configPath, 'new-session', '-d', '-P', '-F', '#{pane_id}\t#{pane_pid}', '-s', run.tmux_name, '-x', '140', '-y', '40', '-c', session.project,
      '-e', `HARBOR_HOME=${this.config.home}`, '-e', `HARBOR_SESSION_ID=${session.id}`, '-e', `HARBOR_RUN_ID=${run.id}`,
      command.binary, ...command.args]);
    fs.chmodSync(this.config.tmuxSocket, 0o600);
    const [paneId, pid] = result.split('\t');
    return { paneId, pid: Number(pid) };
  }
  paste(run, text) {
    const buffer = 'harbor-' + run.id;
    this.call(['load-buffer', '-b', buffer, '-'], { input: text });
    try { this.call(['paste-buffer', '-d', '-p', '-b', buffer, '-t', run.pane_id]); }
    catch (error) { try { this.call(['delete-buffer', '-b', buffer]); } catch {} throw error; }
  }
  async pasteImages(run, images, checkControl) {
    const initial = codexComposerImages(this.capture(run));
    if (initial === null || initial.length) fail('IMAGE_COMPOSER_NOT_READY', 'Open the existing Codex terminal and inspect its draft before sending images.');
    for (let index = 0; index < images.length; index++) {
      checkControl();
      this.paste(run, quote(images[index].storedPath));
      const deadline = Date.now() + 5000;
      for (;;) {
        checkControl();
        const attached = codexComposerImages(this.capture(run));
        if (attached?.length === index + 1 && attached.every((number, position) => number === position + 1)) break;
        if (Date.now() >= deadline) fail('IMAGE_ATTACH_UNCONFIRMED', 'Codex did not confirm the image attachment. The draft was not submitted; inspect the terminal before retrying.');
        await delay(100);
      }
    }
  }
  enter(run) { this.call(['send-keys', '-t', run.pane_id, 'Enter']); }
  exit(run) { this.call(['send-keys', '-t', run.pane_id, '-l', '/exit']); }
  capture(run) { return this.call(['capture-pane', '-p', '-J', '-S', '-300', '-t', run.pane_id]); }
  setClientOwner(client, owner, flags, tmuxName) {
    const wanted = owner === 'grok';
    const readonly = (flags || '').split(',').includes('read-only');
    try {
      // tmux 3.6b can return success for refresh-client -f !read-only while
      // leaving the client read-only. Its explicit toggle works and is verified.
      if (readonly !== wanted) this.call(['switch-client', '-c', client, '-t', tmuxName, '-r']);
      const current = this.call(['list-clients', '-F', '#{client_name}\t#{session_name}\t#{client_flags}']).split('\n').find(line => line.startsWith(client + '\t'));
      if (!current) return; // Client detached while changing ownership.
      const [, attachedSession, currentFlags] = current.split('\t');
      if (attachedSession !== tmuxName) fail('CLIENT_SESSION_CHANGED', 'Terminal client attached to a different session during the control change.');
      const observed = (currentFlags || '').split(',').includes('read-only');
      if (observed !== wanted) fail('CLIENT_CONTROL_FAILED', 'Terminal client did not confirm the requested control mode.');
    } catch (error) {
      if (wanted) this.call(['detach-client', '-t', client]);
      else throw error;
    }
  }
  enforce(run, owner) {
    const clients = this.call(['list-clients', '-t', run.tmux_name, '-F', '#{client_name}\t#{client_flags}']).split('\n').filter(Boolean);
    for (const line of clients) { const [client, flags] = line.split('\t'); this.setClientOwner(client, owner, flags, run.tmux_name); }
    return clients.length;
  }
  syncOwnership(sessions) {
    let clients;
    try { clients = this.call(['list-clients', '-F', '#{session_name}\t#{client_name}\t#{client_flags}']); }
    catch (error) { if (/no server running|error connecting.*No such file|no sessions/.test(error.message)) return; throw error; }
    const owners = new Map(sessions.map(s => [s.tmuxName, s.owner]));
    for (const line of clients.split('\n').filter(Boolean)) {
      const [name, client, flags] = line.split('\t');
      const owner = owners.get(name);
      if (!owner || (flags || '').split(',').includes('read-only') === (owner === 'grok')) continue;
      this.setClientOwner(client, owner, flags, name);
    }
  }
  removeDeadSession(run) {
    const panes = [...this.panes().values()].filter(pane => pane.name === run.tmux_name);
    if (!panes.length || panes.some(pane => pane.alive)) return false;
    this.call(['kill-session', '-t', run.tmux_name]); return true;
  }
  args(run, readonly) { return ['-S', this.config.tmuxSocket, 'attach-session', ...(readonly ? ['-f', 'read-only,ignore-size'] : []), '-t', run.tmux_name]; }
}
