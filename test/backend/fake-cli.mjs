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
const nativeId = resume >= 0 ? args[resume + 1] : provider === 'claude' ? args[args.indexOf('--session-id') + 1] : randomUUID();
const historyDirectory = path.join(home, 'fake-native');
fs.mkdirSync(historyDirectory, { recursive: true });
const historyFile = path.join(historyDirectory, nativeId + '.json');
let history = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile, 'utf8')) : [];
let activeTurn;
function emit(event, data = {}) {
  fs.appendFileSync(path.join(home, 'runs', runId, 'events.jsonl'), JSON.stringify({ time: new Date().toISOString(), sessionId, runId, provider,
    event: { hook_event_name: event, session_id: nativeId, cwd: process.cwd(), ...(activeTurn ? { [provider === 'codex' ? 'turn_id' : 'prompt_id']: activeTurn } : {}), ...data } }) + '\n');
}
function finish(response, extra = {}) { process.stdout.write('\r\n' + response + '\r\n> '); emit('Stop', { last_assistant_message: response, ...extra }); }
function prompt(text) {
  if (text === '/exit') { emit('SessionEnd'); setTimeout(() => process.exit(0), 30); return; }
  activeTurn = randomUUID();
  emit('UserPromptSubmit', { prompt: text });
  if (text === 'BLOCK') { emit('PermissionRequest', { tool_name: 'Write' }); return; }
  if (text === 'AFTER_STOP') { finish('intermediate'); setTimeout(() => { emit('PostToolUse', { tool_name: 'test' }); finish('final'); }, 250); return; }
  if (text === 'BACKGROUND') { finish('background', { background_tasks: ['task'] }); return; }
  const marker = /MARKER:(\S+)/.exec(text)?.[1];
  if (marker) { history.push(marker); fs.writeFileSync(historyFile, JSON.stringify(history)); }
  const response = text.includes('RECALL') ? 'MEMORY:' + history.join(',') : text === 'SLOW' ? 'slow complete' : 'ANSWER:' + text;
  setTimeout(() => { emit('PostToolUse', { tool_name: 'Read', tool_response: 'fixture' }); finish(response); }, text === 'SLOW' ? 1200 : 80);
}
emit('SessionStart');
process.stdout.write('Fake interactive ' + provider + '\r\n> ');
process.stdin.setRawMode?.(true);
process.stdin.resume();
let buffer = '';
process.stdin.on('data', chunk => {
  let input = chunk.toString('utf8').replaceAll('\x1b[200~', '').replaceAll('\x1b[201~', '');
  for (const character of input) {
    if (character === '\r') { const text = buffer; buffer = ''; prompt(text); }
    else if (character === '\x03') { emit(provider === 'codex' ? 'Interrupt' : 'StopFailure'); buffer = ''; }
    else buffer += character;
  }
});
const dash = args.lastIndexOf('--');
if (dash >= 0 && args[dash + 1]) setTimeout(() => prompt(args[dash + 1]), 20);
