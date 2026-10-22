#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { readRequest } from '../broker/request-file.mjs';
import { snapshotLines } from '../broker/output.mjs';
import { rpc } from '../broker/client.mjs';
import { errorJSON, fail } from '../broker/common.mjs';

const raw = process.argv.slice(2);
const action = raw.shift();
const options = {}, positional = [];
let cliArgumentFormat = null;
const booleans = new Set(['compact', 'archived', 'include-archived', 'chunked', 'through-attention', 'start']);
const accepted = new Set(['provider','project','title','text','image','request-id','owner','actor','id','timeout','after','cli-arg','cli-args','request-file','folder','add','remove',...booleans]);
try {
  if (Number(process.versions.node.split('.')[0]) < 24) fail('UNSUPPORTED_NODE', 'Agent Harbor requires Node.js 24 or newer.');
  for (let index = 0; index < raw.length; index++) {
    const token = raw[index];
    if (!token.startsWith('--')) { positional.push(token); continue; }
    const option = token.slice(2);
    if (!accepted.has(option)) fail('INVALID_OPTION', `Unknown option --${option}.`);
    const key = option.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (option === 'image') { if (index + 1 >= raw.length) fail('INVALID_OPTION', 'Missing image path.'); (options.images ||= []).push(raw[++index]); continue; }
    if (option === 'cli-arg') { if (cliArgumentFormat === 'json') fail('INVALID_OPTION', 'Use either --cli-args or repeated --cli-arg.'); cliArgumentFormat = 'literal'; if (index + 1 >= raw.length) fail('INVALID_OPTION', 'Missing literal argument.'); (options.cliArgs ||= []).push(raw[++index]); continue; }
    if (option === 'cli-args') { if (cliArgumentFormat) fail('INVALID_OPTION', 'Use either --cli-args or repeated --cli-arg.'); cliArgumentFormat = 'json'; try { options.cliArgs = JSON.parse(raw[++index]); } catch { fail('INVALID_CLI_ARGS', '--cli-args must be a JSON array.'); } continue; }
    if (booleans.has(option)) options[key] = true;
    else { if (index + 1 >= raw.length) fail('INVALID_OPTION', `Missing value for --${option}.`); options[key] = raw[++index]; }
  }
  if (options.requestFile) {
    if (!['create','send','start','resume'].includes(action) || Object.keys(options).length !== 1 || positional.length) fail('INVALID_OPTION', '--request-file supports create, send, start and resume and cannot be combined with other arguments. Include the session id in the file.');
    const request = readRequest(options.requestFile, action);
    delete options.requestFile; Object.assign(options, request);
  }
  if (cliArgumentFormat && (action !== 'create' || !Array.isArray(options.cliArgs))) fail('INVALID_CLI_ARGS', 'Startup arguments must be a JSON array supplied to create.');
  if (options.includeArchived) options.archived = true;
  if (positional[0]) options.id = positional[0];
  if (action === 'control' && positional[1]) options.owner = positional[1];
  if (action === 'help' || action === '--help' || !action) {
    process.stdout.write(JSON.stringify({ ok: true, commands: ['list [--compact --archived]', 'watch [--compact --archived --chunked]', 'create --provider codex|claude --project /absolute/path [--id UUID --title NAME --owner human|grok --text TEXT --image /absolute/image.png --request-id ID --cli-args JSON --start]', 'create|start|resume|send --request-file /private/request.json', 'start|resume ID [--text TEXT --image /absolute/image.png --request-id ID --actor human|grok]', 'send ID --request-id ID [--text TEXT --image /absolute/image.png --actor human|grok]', 'result ID [--request-id ID]', 'wait ID --request-id ID [--timeout MS --through-attention]', 'stop ID [--actor human|grok]', 'control ID human|grok', 'trust ID [--folder /absolute/parent]', 'trusted-folders [--add /absolute/folder | --remove /absolute/folder]', 'rename ID --title NAME', 'archive ID', 'restore ID', 'capture ID', 'events ID [--after CURSOR]', 'attach ID', 'doctor'], trust: 'Only the human answers a workspace-trust prompt (trust) or edits the folders whose projects Harbor trusts automatically (trusted-folders).', images: 'Repeat --image for up to 8 local PNG/JPEG/WebP files, 10 MiB each and 32 MiB total. Request JSON uses images: [absolute paths].' }, null, 2) + '\n');
  } else if (action === 'attach') {
    const info = await rpc('attach-info', options);
    const child = spawn(info.command, info.args, { stdio: 'inherit', env: { ...process.env, TERM: process.env.TERM || 'xterm-256color' } });
    child.once('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
    await new Promise(resolve => child.once('exit', code => { process.exitCode = code || 0; resolve(); }));
  } else if (action === 'watch') {
    for (;;) {
      try { await rpc('watch', options, { onEvent: value => { if (options.chunked) { for (const line of snapshotLines(value)) process.stdout.write(line + '\n'); } else process.stdout.write(JSON.stringify(value) + '\n'); } }); }
      catch (error) { if (!['DAEMON_DISCONNECTED', 'ECONNRESET', 'EPIPE', 'RPC_TIMEOUT'].includes(error.code)) throw error; }
      await delay(250);
    }
  } else {
    const response = await rpc(action, options);
    process.stdout.write(JSON.stringify(response, null, 2) + '\n');
    if (action === 'wait' && response.outcome !== 'completed') process.exitCode = response.outcome === 'timeout' ? 3 : 2;
  }
} catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: errorJSON(error) }) + '\n'); process.exitCode = 1; }
