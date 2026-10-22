# CLI startup options

A Harbor session can store additional arguments for its original interactive CLI. They are literal argument strings, not a shell command. Settings and login remain owned by Claude Code or Codex; project trust is answered in their own dialog ([workspace trust](WORKSPACE-TRUST.md)).

```sh
harbor create --provider codex --project "$PWD" --title "Review" \
  --cli-args '["--model","your-model","--add-dir","/another/project"]'
```

The equivalent repeated form is:

```sh
harbor create --provider claude --project "$PWD" --title "Review" \
  --cli-arg '--model' --cli-arg 'your-model' \
  --cli-arg '--effort' --cli-arg 'high'
```

Use either the JSON form or the repeated form. Arguments are supplied at creation, persisted with the conversation and reapplied when it starts or resumes. Harbor does not offer an operation to rewrite an existing session's startup configuration. Native interactive commands such as `/model` remain available in the terminal.

`result SESSION_ID` includes `session.cliArgs` and `session.workingDirectory`. `project` is the original selected project; `workingDirectory` can be a managed worktree. `cli-args SESSION_ID` returns only the session's `provider`, `project` and `cliArgs`, with no responses, so its size stays within the startup-argument limit; the compact list omits arguments.

## Desktop form

The new-session form offers Model, Effort and Worktree above the additional JSON arguments. Each starts at **CLI default**, which adds nothing, so the CLI's own configuration decides. A choice becomes the provider's own option, placed before the JSON arguments and checked by the same allowlist:

| Field | Claude Code | Codex |
|---|---|---|
| Model (free text) | `--model NAME` | `--model NAME` |
| Effort | `--effort low\|medium\|high\|xhigh\|max` | `-c model_reasoning_effort="minimal\|low\|medium\|high\|xhigh"` |
| Worktree: New worktree | `--worktree` | `--worktree` |

Harbor does not ask the CLIs for a model catalog; the field suggests the models used before with that provider. If the JSON also sets one of these options, the form asks to keep only one. The app remembers the last provider and, for each provider, the last model, effort and worktree choice in `ui-new-session.json` next to its other local state. **New session like this** in a session's context menu reads that session's `cli-args` and opens the form with its provider, original project and startup arguments, split back into these fields where they match.

## Supported options and boundaries

The argument adapter follows the interactive options exposed by Codex 0.162.1 and Claude Code 2.1.302 at implementation time. It validates argument grouping and passes values to the provider unchanged. The installed provider remains responsible for validating model names, feature names, file paths and option values.

Supported categories include model selection, Codex profiles and ordinary configuration overrides, additional directories, initial images/files, Claude agents and MCP/plugin configuration, effort, system-prompt options, worktrees, and compatible interactive presentation options. See `broker/arguments.mjs` for the exact current option inventory and aliases.

Harbor rejects options that collide with its managed lifecycle:

- Conversation selectors, resume/fork/session IDs and working-root overrides. Use Harbor session IDs and its `--project` selection.
- Provider subcommands and positional prompt arguments. Use Harbor lifecycle commands and `--text`.
- Headless output, background/remote/cloud launch modes and alternative app entry points. Managed sessions use the original local interactive CLI.
- Hook/settings replacement, hook-disabled modes and hook-trust bypass flags. The observer must remain available for reliable response attribution. Codex `--disable hooks`, `features.hooks` overrides and whole `features` table replacements are reserved; other individual feature overrides remain available.
- Explicit permission/sandbox bypass modes. Harbor never grants tool approvals and never bypasses the trust dialog.

An unknown option returns `UNSUPPORTED_CLI_ARGUMENT`. A reserved one returns `RESERVED_CLI_ARGUMENT`. A newer provider option may require an adapter update. This is not a claim that every historical, future, noninteractive or provider-management subcommand can be launched as a Harbor conversation.

## Worktree behavior

`--worktree` creates a worktree only on the first launch. Claude's optional worktree name is supported. The observer accepts a changed working directory only after Git confirms that it belongs to the same repository, then records that directory. A resumed process starts in the recorded directory and omits the worktree-creation flag, preserving the original workspace rather than creating another one.

Claude refuses `--worktree` in a folder it does not trust yet. Harbor then shows Claude's trust dialog in a helper and repeats the identical first launch once it is answered ([details](WORKSPACE-TRUST.md#worktrees)).

If the worktree is missing, resume returns `WORKTREE_MISSING`. Restore that directory before retrying. The CLI's own exit questions, including worktree retention questions, remain visible. Harbor does not answer them or force termination on an exit timeout.

The argument/persistence and Git-identity behavior has automated coverage. Real provider worktree onboarding and all advanced option combinations need their own live verification; the ordinary multi-session lifecycle test does not certify them.

## Requests too large for native command arguments

The desktop client can write a private JSON request and use a short command:

```sh
harbor create --request-file /private/path/request.json
```

The file contains a JSON object with the normal create fields: `id`, `requestId`, `provider`, `project`, `title`, `owner`, `text`, `cliArgs` and `start`. `start: true` (or `create --start`) launches the CLI even without a task, with Harbor's small initialization turn. Without `title`, the session is named from its first task (first meaningful line, at most 60 characters, image mentions removed) or else its folder. A stable UUID in `id` and a stable `requestId` allow retry without creating another conversation or delivering another first prompt.

`--request-file` is exclusive: it cannot be combined with other arguments. The file must be a regular file, not a symbolic link, and must not exceed 128 KiB. Unknown fields are rejected. Harbor reads it without shell interpretation and leaves it available for retry. The caller owns removal and should keep it in a private directory because it contains the task text.

## Terminal history cleanup

On resume, Harbor saves the final screen of historical runs in the private state directory at `runs/<run-id>/final-screen.txt`, then removes their tmux session only when every pane is dead. A living secondary pane prevents cleanup. The current run, native conversation history, event journal and SQLite request records are retained.

## Images belong to a request

Use Harbor’s repeated `--image` option or the request JSON `images` array. Do not put Codex `--image`/`-i` in persistent `--cli-args`: Harbor reserves those flags so an old image is not automatically attached on every resume. Image delivery is available for both providers at creation, start, send and resume. See [the bot image contract](GROK-BOT.md#images-from-the-bot).

Existing records from older releases that contain Codex startup image flags remain readable. Their initial launch can still use those saved flags; resume omits the old images. Supply current images explicitly on the new request.
