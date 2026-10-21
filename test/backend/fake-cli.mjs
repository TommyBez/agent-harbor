#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const args = process.argv.slice(2);
const home = process.env.HARBOR_HOME;
const runId = process.env.HARBOR_RUN_ID;
const sessionId = process.env.HARBOR_SESSION_ID;
const provider = args.includes('--no-daemon') ? 'codex' : 'claude';
const resume = args.indexOf(provider === 'codex' ? 'resume' : '--resume');
const nativeId = resume >= 0 ? args[resume + 1] : provider === 'claude' && args.includes('--session-id') ? args[args.indexOf('--session-id') + 1] : randomUUID();
const historyDirectory = path.join(home, 'fake-native');
fs.mkdirSync(historyDirectory, { recursive: true });
const historyFile = path.join(historyDirectory, nativeId + '.json');
let history = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile, 'utf8')) : [];
let activeTurn;
// .fake-helper-no-hooks: a helper launch (no --session-id) whose hooks never report, like a failing observer.
const silent = !args.includes('--session-id') && !args.includes('--resume') && !args.includes('--no-daemon') && fs.existsSync(path.join(process.cwd(), '.fake-helper-no-hooks'));
function emit(event, data = {}) {
  if (silent) return;
  fs.appendFileSync(path.join(home, 'runs', runId, 'events.jsonl'), JSON.stringify({ time: new Date().toISOString(), sessionId, runId, provider,
    event: { hook_event_name: event, session_id: nativeId, cwd: process.cwd(), ...(activeTurn ? { [provider === 'codex' ? 'turn_id' : 'prompt_id']: activeTurn } : {}), ...data } }) + '\n');
}
function finish(response, extra = {}) { process.stdout.write('\r\n' + response + '\r\n> '); emit('Stop', { last_assistant_message: response, ...extra }); }
function prompt(text) {
  if (text === '/exit') { emit('SessionEnd'); setTimeout(() => process.exit(0), 30); return; }
  activeTurn = randomUUID();
  emit('UserPromptSubmit', { prompt: text });
  // A dialog the human must answer: Claude also sends its permission_prompt Notification once the dialog waits.
  if (text === 'BLOCK') { emit('PermissionRequest', { tool_name: 'Write' }); if (provider === 'claude') setTimeout(() => emit('Notification', { notification_type: 'permission_prompt' }), 100); return; }
  // A permission another hook or reviewer answers at once: the tool runs and no dialog is shown.
  if (text === 'AUTO_ALLOWED') { emit('PermissionRequest', { tool_name: 'Bash' }); setTimeout(() => { emit('PostToolUse', { tool_name: 'Bash' }); finish('allowed'); }, 1500); return; }
  // Claude's Bash tool keeps a cd into a subdirectory for later tools and hooks.
  if (text === 'CD_SUBDIR') { const sub = path.join(process.cwd(), 'sub'); fs.mkdirSync(sub, { recursive: true }); setTimeout(() => { emit('PostToolUse', { tool_name: 'Bash', cwd: sub }); process.stdout.write('\r\nin sub\r\n> '); emit('Stop', { last_assistant_message: 'done in sub', cwd: sub }); }, 80); return; }
  if (text === 'FAIL_OVERLOADED' || text === 'FAIL_BILLING') { setTimeout(() => emit('StopFailure', { error: text === 'FAIL_OVERLOADED' ? 'overloaded' : 'billing_error' }), 80); return; }
  if (text === 'CRON') { finish('scheduled', { session_crons: [{ id: 'every-hour', recurring: true }] }); return; }
  // A turn the human interrupts with Esc: Claude fires no further hook for it.
  if (text === 'NEVER_STOPS') { setTimeout(() => emit('PostToolUse', { tool_name: 'Read' }), 50); return; }
  if (text === 'AFTER_STOP') { finish('intermediate'); setTimeout(() => { emit('PostToolUse', { tool_name: 'test' }); finish('final'); }, 250); return; }
  if (text === 'BACKGROUND') { finish('background', { background_tasks: ['task'] }); return; }
  const marker = /MARKER:(\S+)/.exec(text)?.[1];
  if (marker) { history.push(marker); fs.writeFileSync(historyFile, JSON.stringify(history)); }
  const response = text.includes('RECALL') ? 'MEMORY:' + history.join(',') : text === 'SLOW' ? 'slow complete' : text === 'PATH?' ? 'PATH:' + process.env.PATH : 'ANSWER:' + text;
  setTimeout(() => { emit('PostToolUse', { tool_name: 'Read', tool_response: 'fixture' }); finish(response); }, text === 'SLOW' ? 1200 : 80);
}
// Startup dialogs copied from Claude Code 2.1.302 and Codex 0.162.1. A project marks itself with
// .fake-untrusted (trust dialog until .fake-trusted exists), .fake-update (Codex update notice) and
// .fake-hooks (Codex hook review until .fake-hooks-trusted exists).
const hasMarker = name => fs.existsSync(path.join(process.cwd(), name));
const untrusted = hasMarker('.fake-untrusted') && !hasMarker('.fake-trusted');
if (provider === 'claude' && untrusted && args.some(arg => arg === '--worktree' || arg === '-w')) {
  process.stdout.write('Error creating worktree: Workspace trust not yet accepted. Run `claude` once in this directory and accept the trust dialog, then retry with --worktree.\r\n');
  process.exit(1);
}
const hooksPending = () => provider === 'codex' && hasMarker('.fake-hooks') && !hasMarker('.fake-hooks-trusted');
const afterTrust = () => hooksPending() ? 'hooks' : 'repl';
let mode = provider === 'codex' && hasMarker('.fake-update') ? 'update' : untrusted ? 'trust' : afterTrust();
let choice = 0;
function render() {
  process.stdout.write('\x1b[2J\x1b[H');
  if (mode === 'hooks') process.stdout.write(['  Hooks need review', '  7 hooks are new or changed.', '  Hooks can run outside the sandbox after you trust them.', ...['1. Review hooks', '2. Trust all and continue', "3. Continue without trusting (hooks won't run)"].map((label, index) => (choice === index ? '› ' : '  ') + label), '  enter confirm · esc skip'].join('\r\n'));
  else if (mode === 'update') process.stdout.write(['  Update available · 0.162.1 → 0.163.0', '› 1. Update now (runs `install.sh`)', '  2. Skip', '  3. Skip until next version', '  enter continue · esc skip'].join('\r\n'));
  else if (provider === 'claude') process.stdout.write([' Accessing workspace:', ' ' + process.cwd(), ' Quick safety check: Is this a project you created or one you trust?', (choice === 0 ? ' ❯ ' : '   ') + 'No, exit', (choice === 1 ? ' ❯ ' : '   ') + 'Yes, I trust this folder', ' Enter to confirm · Esc to cancel'].join('\r\n'));
  else process.stdout.write(['  Folder access', '  ' + process.cwd(), '  Trust this folder? Codex can read, edit, and run files here.', '› 1. Trust and continue', '  2. Back to Agent Command Center', '  enter continue · esc back'].join('\r\n'));
}
function dialogKey(input) {
  if (mode === 'update') {
    if (input === '\r') fs.writeFileSync(path.join(process.cwd(), '.fake-updated'), 'installed');
    if (input === '\r' || input === '\x1b') { mode = untrusted ? 'trust' : afterTrust(); return mode === 'repl' ? startSession() : render(); }
    return;
  }
  if (mode === 'hooks') {
    if (input === '\x1b[B' || input === '\x1bOB') { choice = Math.min(2, choice + 1); return render(); }
    if (input === '\r' && choice === 1) { fs.writeFileSync(path.join(process.cwd(), '.fake-hooks-trusted'), 'trusted'); mode = 'repl'; return startSession(); }
    return;
  }
  if (input === '\x1b[B' || input === '\x1bOB') { choice = provider === 'claude' ? 1 - choice : choice; return render(); }
  const accepted = input === '\r' && (provider === 'codex' || choice === 1);
  if (accepted) { fs.writeFileSync(path.join(process.cwd(), '.fake-trusted'), 'trusted'); mode = afterTrust(); choice = 0; return mode === 'repl' ? startSession() : render(); }
  if (input === '\r' || input === '\x1b') process.exit(1);
}
function startSession() {
  process.stdout.write('\x1b[2J\x1b[H');
  emit('SessionStart');
  process.stdout.write('Fake interactive ' + provider + '\r\n> ');
  const dash = args.lastIndexOf('--');
  if (dash >= 0 && args[dash + 1]) setTimeout(() => prompt(args[dash + 1]), 20);
}
process.stdin.setRawMode?.(true);
process.stdin.resume();
let buffer = '';
let pendingEscape = null;
process.stdin.on('data', chunk => {
  if (mode !== 'repl') {
    // Like a terminal's escape-time: a lone ESC may be the start of a cursor key split across reads.
    const input = (pendingEscape ? '\x1b' : '') + chunk.toString('utf8');
    clearTimeout(pendingEscape); pendingEscape = null;
    if (input === '\x1b') { pendingEscape = setTimeout(() => { pendingEscape = null; dialogKey('\x1b'); }, 50); return; }
    dialogKey(input); return;
  }
  let input = chunk.toString('utf8').replaceAll('\x1b[200~', '').replaceAll('\x1b[201~', '');
  for (const character of input) {
    if (character === '\r') { const text = buffer; buffer = ''; prompt(text); }
    else if (character === '\x03') { emit(provider === 'codex' ? 'Interrupt' : 'StopFailure'); buffer = ''; }
    else buffer += character;
  }
});
if (mode === 'repl') startSession(); else render();
