import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const CLI = path.join(ROOT, 'bin/harbor.mjs');
export const now = () => new Date().toISOString();
export class HarborError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}
export function fail(code, message, details) { throw new HarborError(code, message, details); }
export function errorJSON(error) { return { code: error.code || 'INTERNAL_ERROR', message: error.message, ...(error.details ? { details: error.details } : {}) }; }
export const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export function hashPrompt(text) { return createHash('sha256').update(text.replace(/^<\/?pasted_content\b[^>]*>\r?\n?/gm, '').replaceAll('\r\n', '\n').trim()).digest('hex'); }
export const hashPayload = text => createHash('sha256').update(text).digest('hex');
export function validateText(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 256_000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) fail('INVALID_TEXT', 'Provide nonempty text without terminal control characters (maximum 256,000 characters).');
  return text;
}
export function validateActor(actor) { if (!['human', 'grok'].includes(actor)) fail('INVALID_ACTOR', 'Actor must be human or grok.'); return actor; }
export function processAlive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
export function configuration(env = process.env) {
  const home = path.resolve(env.HARBOR_HOME || path.join(os.homedir(), 'Library/Application Support/Agent Harbor'));
  const socket = path.join(home, 'daemon.sock');
  if (Buffer.byteLength(socket) > 100) fail('HOME_PATH_TOO_LONG', 'HARBOR_HOME is too long for a Unix socket. Choose a shorter absolute path.');
  const configFile = path.join(home, 'config.json');
  let configured = {};
  if (fs.existsSync(configFile)) {
    try { configured = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch (error) { fail('CONFIG_INVALID', `Cannot read ${configFile}: ${error.message}`); }
  }
  return { home, socket, tmuxSocket: path.join(home, 'tmux.sock'), database: path.join(home, 'harbor.sqlite'), env, executables: configured.executables || {}, startupTimeout: 30_000, stopTimeout: 20_000 };
}
export function ensurePrivateHome(config) {
  fs.mkdirSync(config.home, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(config.home);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) fail('UNSAFE_HOME', 'State directory must be a real directory owned by the current user.');
  fs.chmodSync(config.home, 0o700);
  for (const name of ['runs', 'logs']) fs.mkdirSync(path.join(config.home, name), { recursive: true, mode: 0o700 });
}
export function executable(name, config) {
  const explicit = config.executables[name];
  const search = explicit ? [explicit] : [
    ...String(config.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name)),
    path.join(os.homedir(), '.local/bin', name), '/opt/homebrew/bin/' + name, '/usr/local/bin/' + name,
  ];
  for (const candidate of search) {
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return path.resolve(candidate); } catch {}
  }
  fail('DEPENDENCY_MISSING', `Cannot find ${name}. Install it or set executables.${name} in ${path.join(config.home, 'config.json')}.`);
}
