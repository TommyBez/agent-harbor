# Workspace trust

Before Claude Code or Codex works in a new folder, it asks whether you trust that folder. The question matters: a repository can ship its own settings, hooks and MCP servers, and trusting the folder lets the CLI load and run them. Codex also asks you to review hooks that are new or have changed. This includes Harbor's own observer hooks whenever their command path changes, for example after moving from a source checkout to the packaged app.

A bot cannot answer these questions, so without help a bot-started session stalls until a person notices it. Harbor removes that bottleneck in two ways and never takes the decision away from you.

## Answer from Harbor in one click

When the CLI shows its trust dialog, Harbor marks the session **Trust needed** and the bot's `wait` returns `attention` with one of these errors:

| `session.error` | Dialog | Button |
|---|---|---|
| `TRUST_REQUIRED` | Claude "Accessing workspace… Yes, I trust this folder" or Codex "Trust this folder?" | **Trust folder** |
| `HOOK_TRUST_REQUIRED` | Codex "Hooks need review" | **Trust hooks** |

The banner names the folder (`session.trustFolder`). Clicking the button answers the CLI's own dialog. You don't need to take control, and the bot keeps control of its session. The bot tells you once, then waits on the same request ID with `wait --through-attention`, and continues as soon as the CLI starts. Before pressing Enter, Harbor checks that the highlighted choice is the trusting one: Claude highlights "No, exit" by default, so Harbor first selects "Yes". If the dialog changed meanwhile, Harbor stops with `TRUST_PROMPT_CHANGED` and you answer in the terminal.

From the command line, the same action is:

```sh
harbor trust SESSION_ID                       # answer the dialog once
harbor trust SESSION_ID --folder /parent/dir  # also pre-authorize a parent folder (below)
```

Only the human can do this. The bot's `--actor grok` is refused with `TRUST_HUMAN_ONLY`.

## Pre-authorized folders

To skip the question entirely for your own projects, pre-authorize the folder that contains them. Use **Always trust ‹parent›** in the banner, or:

```sh
harbor trusted-folders --add ~/play-games
harbor trusted-folders                       # list
harbor trusted-folders --remove ~/play-games
```

For any launch whose directory is inside a pre-authorized folder, Harbor answers the folder-trust dialog and Codex's hook review itself, for bot and human sessions alike. Each answer is recorded in the audit log as `trust_auto_accepted`, with the folder and the pre-authorized folder that allowed it.

This is a real security decision. Every repository inside a pre-authorized folder can run its own hooks, settings and MCP servers without review, including a repository the bot clones there. Pre-authorize folders that hold your own code, not a downloads or scratch folder. The whole disk and your home folder are refused (`TRUSTED_FOLDER_TOO_BROAD`). Symbolic links cannot widen the scope: paths are resolved before comparison. The list lives in `config.json` in Harbor's state directory, and only the human may change it.

## What Harbor never answers

- Tool permission requests and other prompts in a running conversation (`PERMISSION_REQUIRED`, `CLI_ATTENTION_REQUIRED`).
- Logins, onboarding and any dialog it does not recognize exactly.
- Codex's update notice beyond skipping it once. For a bot-owned session, Harbor presses Esc ("skip") so the launch can continue. It never chooses "Update now" and never chooses "Skip until next version", which would be saved.

Harbor answers through the CLI's own dialog, so the CLI records the decision in its own configuration exactly as if you had pressed the keys. Harbor does not edit the CLI's configuration files and uses no trust-bypass flag.

## Worktrees

Claude Code refuses `--worktree` in an untrusted folder and exits at once: "Workspace trust not yet accepted". It never shows its dialog. Harbor recognizes that exit on the first launch of a worktree session. It then opens plain `claude` in the project, with no conversation and no task, so Claude shows its own trust dialog in the session's terminal. That dialog is answered as described above. Once Claude starts, Harbor ends this helper with SIGTERM and repeats the original launch with the same arguments, native session ID and request ID. The helper's terminal is writable for the human even in a bot session, because it holds no conversation.

A worktree session that died at this check before the helper existed, for example under an older controller, can simply be started or resumed again. Every one of its launches failed before any conversation existed, so Harbor treats the next one as a first launch with a new native session ID, and the trust helper takes over from there.

To repeat the launch, Harbor keeps a private copy of the first launch command, including the task text, in that run's directory (`runs/<run-id>/launch.json`, mode 0600) until the launch is repeated or abandoned. The run's hook journal already holds the same text.

## Declining

If you choose "No, exit", no conversation is created. The request ends as `interrupted` with error `TRUST_DECLINED`, and the session returns to its never-started state with `status: stopped` and no native ID. `start` can begin it again later with a new request ID. `resume` returns `SESSION_NOT_STARTED`.

## Supported versions

The dialog texts are matched exactly as Claude Code 2.1.302 and Codex 0.162.1 render them. A provider update that changes the wording turns automatic answers off: the session reports `HOOKS_NOT_READY` and the terminal shows the dialog for you to answer, as before. Recheck the patterns in `broker/trust.mjs` when you update a provider.
