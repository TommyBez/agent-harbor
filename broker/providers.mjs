import fs from 'node:fs';
import path from 'node:path';
import { cliArgsForLaunch } from './arguments.mjs';
import { ROOT, executable, quote } from './common.mjs';

export const OBSERVED_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd', 'PermissionRequest'];
export function launchCommand(session, config, prompt, images = []) {
  const binary = executable(session.provider, config);
  const command = [process.execPath, path.join(ROOT, 'broker/hooks/observe.mjs'), session.provider].map(quote).join(' ');
  const hook = [{ hooks: [{ type: 'command', command, timeout: 3 }] }];
  if (session.provider === 'codex') {
    const args = [...cliArgsForLaunch(session), '--no-daemon', '-C', session.working_directory || session.project];
    for (const event of [...OBSERVED_EVENTS, 'Interrupt']) args.push('-c', `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=3}]}]`);
    if (session.native_id) args.push('resume', session.native_id);
    for (const image of images) args.push('--image', image.storedPath);
    if (prompt) args.push('--', prompt);
    return { binary, args };
  }
  const filename = claudeHooks(config, hook);
  return { binary, args: [...cliArgsForLaunch(session), session.resuming ? '--resume' : '--session-id', session.native_id, '--settings', filename, ...(prompt ? ['--', prompt] : [])] };
}
function claudeHooks(config, hook) {
  const filename = path.join(config.home, 'claude-hooks.json');
  // Claude-only events: failed tools and auto-mode denials also show the turn moving on after a permission request.
  fs.writeFileSync(filename, JSON.stringify({ hooks: Object.fromEntries([...OBSERVED_EVENTS, 'StopFailure', 'Notification', 'PostToolUseFailure', 'PermissionDenied'].map(event => [event, hook])) }), { mode: 0o600 });
  return filename;
}
/** Plain interactive Claude with no conversation, so it can show its own workspace-trust dialog. */
export function trustHelperCommand(config) {
  const command = [process.execPath, path.join(ROOT, 'broker/hooks/observe.mjs'), 'claude'].map(quote).join(' ');
  return { binary: executable('claude', config), args: ['--settings', claudeHooks(config, [{ hooks: [{ type: 'command', command, timeout: 3 }] }])] };
}
