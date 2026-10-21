import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fail } from './common.mjs';

const codex = {
  value: ['--model','-m','--profile','-p','--local-provider','--sandbox','-s','--ask-for-approval','-a','--config','-c','--enable','--disable','--add-dir'],
  many: ['--image','-i'], optional: [], boolean: ['--oss','--strict-config','--worktree','--search','--no-alt-screen','--approve-for-me'],
};
const claude = {
  value: ['--agent','--agents','--append-system-prompt','--autocompact','--debug-file','--effort','--fallback-model','--json-schema','--model','--name','-n','--permission-mode','--plugin-dir','--plugin-url','--remote-control-session-name-prefix','--setting-sources','--system-prompt','--system-prompt-snapshot'],
  many: ['--add-dir','--allowedTools','--allowed-tools','--disallowedTools','--disallowed-tools','--betas','--file','--mcp-config','--tools'],
  optional: ['--debug','-d','--prompt-suggestions','--remote-control','--worktree','-w'],
  boolean: ['--ax-screen-reader','--brief','--chrome','--no-chrome','--disable-slash-commands','--exclude-dynamic-system-prompt-sections','--ide','--restricted','--strict-mcp-config','--verbose'],
};
const reserved = new Set(['--','--help','-h','--version','-V','-v','--resume','-r','--session-id','--continue','--fork-session','--from-pr','--teleport','--print','--output-format','--input-format','--no-session-persistence','--bg','--background','--desktop','--cloud','--environment','--remote','--remote-auth-token-env','--settings','--bare','--safe-mode','--tmux','--cd','-C','--no-daemon','--dangerously-bypass-approvals-and-sandbox','--dangerously-bypass-hook-trust','--dangerously-skip-permissions','--allow-dangerously-skip-permissions']);
function normalizedConfigKey(raw) {
  // TOML quoted keys may spell the same feature using Unicode escapes.
  return raw.replace(/"(?:\\.|[^"\\])*"/g, token => {
    try { return JSON.parse(token.replace(/\\U([0-9a-fA-F]{8})/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))); }
    catch { fail('RESERVED_CLI_ARGUMENT', 'Configuration keys must use valid literal TOML names.'); }
  }).replace(/[\s']/g, '');
}
export function argumentGroups(provider, input = []) {
  if (!Array.isArray(input) || input.length > 100 || input.some(arg => typeof arg !== 'string' || arg.length > 8192 || /[\x00-\x1f\x7f]/.test(arg)) || JSON.stringify(input).length > 32768) fail('INVALID_CLI_ARGS', 'CLI arguments must be an array of at most 100 literal strings (32 KiB total).');
  const rules = provider === 'codex' ? codex : claude;
  const groups = [];
  for (let index = 0; index < input.length; index++) {
    const token = input[index];
    const equal = token.indexOf('=');
    const flag = equal > 0 ? token.slice(0, equal) : token;
    if (reserved.has(flag) || provider === 'claude' && ['-c','-p'].includes(flag)) fail('RESERVED_CLI_ARGUMENT', `${flag} is managed by Harbor or conflicts with interactive persistence and normal trust checks.`);
    const kind = Object.keys(rules).find(kind => rules[kind].includes(flag));
    if (!kind) fail('UNSUPPORTED_CLI_ARGUMENT', `Unsupported interactive ${provider} option: ${flag}. Subcommands and positional prompts must use Harbor's lifecycle and --text.`);
    const values = equal > 0 ? [token.slice(equal + 1)] : [];
    const tokens = [token];
    if (kind === 'boolean' && equal > 0) fail('INVALID_CLI_ARGS', `${flag} does not take a value.`);
    if (kind === 'value' && !values.length) {
      if (index + 1 >= input.length || input[index + 1].startsWith('-')) fail('INVALID_CLI_ARGS', `${flag} requires a value.`);
      values.push(input[++index]); tokens.push(input[index]);
    }
    if ((kind === 'optional' || kind === 'many') && equal < 0) {
      while (index + 1 < input.length && !input[index + 1].startsWith('-')) {
        values.push(input[++index]); tokens.push(input[index]); if (kind === 'optional') break;
      }
      if (kind === 'many' && !values.length) fail('INVALID_CLI_ARGS', `${flag} requires at least one value.`);
    }
    if (['--sandbox','-s'].includes(flag) && values[0] === 'danger-full-access' || ['--ask-for-approval','-a'].includes(flag) && values[0] === 'never' || flag === '--permission-mode' && ['bypassPermissions','dontAsk'].includes(values[0])) fail('RESERVED_CLI_ARGUMENT', 'Permission bypass modes are not enabled by Harbor startup arguments.');
    if (provider === 'codex' && flag === '--disable' && values[0].split(',').some(value => value.trim() === 'hooks')) fail('RESERVED_CLI_ARGUMENT', 'Codex hooks are required to correlate the original interactive session and its responses.');
    if (provider === 'codex' && ['-c','--config'].includes(flag)) {
      const key = normalizedConfigKey(values[0].split('=')[0]);
      // Whole feature tables can disable hooks indirectly. Other individual
      // features remain available through --enable/--disable or dotted overrides.
      if (!values[0].includes('=') || /^(hooks|approval|sandbox|permissions|projects|trust|cwd|codex_home)(\.|_|$)/i.test(key) || /^features(?:\.hooks(?:\.|$)|$)/.test(key)) fail('RESERVED_CLI_ARGUMENT', 'Hook, project, identity and permission overrides remain managed by the normal CLI configuration.');
    }
    groups.push({ flag, tokens });
  }
  return groups;
}
export function validateCliArgs(provider, input = []) {
  const groups = argumentGroups(provider, input);
  if (provider === 'codex' && groups.some(group => ['--image','-i'].includes(group.flag))) fail('RESERVED_CLI_ARGUMENT', 'Use Harbor --image for per-request attachments, not persistent --cli-args.');
  return [...input];
}
export function cliArgsForLaunch(session) {
  const groups = argumentGroups(session.provider, JSON.parse(session.cli_args || '[]'));
  // Read old records that used startup images, but do not replay those images
  // on resume. New requests use the separately retained attachment manifest.
  return groups.filter(group => !session.resuming || !['--worktree','-w', ...(session.provider === 'codex' ? ['--image','-i'] : [])].includes(group.flag)).flatMap(group => group.tokens);
}
export function usesWorktree(session) { return argumentGroups(session.provider, JSON.parse(session.cli_args || '[]')).some(group => ['--worktree','-w'].includes(group.flag)); }
export function sameRepository(project, directory) {
  const common = cwd => {
    const value = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore','pipe','ignore'] }).trim();
    return fs.realpathSync(path.resolve(cwd, value));
  };
  try { return common(project) === common(directory); } catch { return false; }
}
/** A linked worktree of the project's repository: the root of a different checkout, not a folder inside the project. */
export function worktreeOf(project, directory) {
  const top = cwd => fs.realpathSync(execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore','pipe','ignore'] }).trim());
  try { const root = top(directory); return root === fs.realpathSync(directory) && root !== top(project) && sameRepository(project, directory); } catch { return false; }
}
