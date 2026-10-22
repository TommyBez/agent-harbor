---
name: agent-harbor
description: Delegate coding work to persistent, interactive Claude Code or Codex sessions on this Mac through the Agent Harbor CLI, and hand sessions between the bot and the human. Use when asked to start a Claude Code or Codex session, send it a task or images, wait for and report its answer, check on, stop or resume an existing Harbor session, or respect a human taking control of one. Not for editing Agent Harbor's own source code.
---

# Use Agent Harbor as a bot

Agent Harbor runs the original interactive `claude` and `codex` CLIs in private tmux sessions on the user's Mac. A local controller tracks each conversation, who may type into it, and every task sent to it. You drive it through a CLI that always answers with JSON. The human watches and takes over in the Agent Harbor desktop app.

Harbor knows two owners: `human` and `grok`. Any automated agent, whatever its name, acts as **`grok`**.

## Rules that are never optional

1. **Always pass `--actor grok`** on `start`, `resume`, `send` and `stop`. The actor defaults to `human`: omitting it impersonates the user. `create` takes `--owner grok` instead and needs no `--actor`.
2. **Never take control from the human.** Do not run `control <id> grok` or act with `--actor human` unless the user explicitly tells you to in this conversation. When a session belongs to the human, only observe.
3. **One session ID per conversation, one request ID per task.** Generate a UUID for `--id` before `create` and a fresh `--request-id` before every task: any short string unique within that session, such as `checkout-review-002` or another UUID. Write both down in your own notes before running the command. Reuse a request ID only to retry the *identical* task.
4. **Never replay an uncertain task under a new request ID.** After a timeout, disconnect or `uncertain` status, read the same receipt with `result`. If it stays uncertain, stop and ask the human to inspect the terminal.
5. **Never approve anything.** Folder trust, Codex hook review, tool permissions and logins belong to the human. Never run `trust` or `trusted-folders`, type Enter into a prompt, edit CLI settings or kill processes. Harbor answers trust itself only in folders the human pre-authorized.
6. **Never resume by "latest".** A closed conversation continues only with `resume` on its own Harbor session ID. Never replace it with a new `create`.
7. **Identify sessions by ID, never by provider.** Several Claude and Codex sessions can exist at once.
8. Work only in a project directory the user authorized, and never publish transcripts, native IDs, credentials or private paths.

## 1. Find the CLI

Run Harbor's own Node.js with its CLI file, passing arguments as a literal array, never through an interpolated shell string. Use whichever installation exists:

```sh
# Desktop app installed from the DMG
HARBOR_NODE="/Applications/Agent Harbor.app/Contents/Resources/runtime/node"
HARBOR_CLI="/Applications/Agent Harbor.app/Contents/Resources/harbor/bin/harbor.mjs"

# Source checkout (Node.js 24+), run from the repository root
HARBOR_NODE="$(command -v node)"
HARBOR_CLI="$PWD/bin/harbor.mjs"

"$HARBOR_NODE" "$HARBOR_CLI" doctor
```

Shell variables may not survive between your tool calls; restate the paths in every invocation. The CLI and the desktop app must share one state directory. It defaults to `~/Library/Application Support/Agent Harbor`; the `HARBOR_HOME` environment variable overrides it. Leave `HARBOR_HOME` unset unless the user configured the same value for the desktop app, and check the `home` field of `doctor` to see which registry you are using.

`doctor` returns `ok: true`, the controller PID and `dependencies` for `tmux`, `codex` and `claude`. If a dependency shows `available: false`, tell the user what is missing; do not install software or change credentials to make it pass. `"$HARBOR_NODE" "$HARBOR_CLI" help` prints the full command list.

## 2. Start a conversation

```sh
"$HARBOR_NODE" "$HARBOR_CLI" create \
  --id 7c1e2f2a-5b1d-4f54-9a43-0d2a4f6b8e11 \
  --provider claude \
  --project "/absolute/path/to/authorized/project" \
  --title "Checkout review" \
  --owner grok \
  --text "Read the checkout module and summarize its structure. Do not modify files." \
  --request-id checkout-review-001
```

- `--provider` is `claude` or `codex`, chosen from the user's request.
- `--title` is optional (1–160 characters). Without it, Harbor names the session from the first line of `--text` (at most 60 characters), or the project folder when there is no task. Use a short description of the task; it is what the human sees in the session list.
- `--owner grok` keeps the session yours until the human takes it.
- `--text` is the first task; without `--text` and images the session is recorded but not started (use `start` later).
- The reply contains `session` and `request`; `request.status` is usually `awaiting_ack` at this point. That is not an answer yet.

## 3. Wait for the answer

```sh
"$HARBOR_NODE" "$HARBOR_CLI" wait <session-id> --request-id checkout-review-001 --timeout 300000
```

Read the JSON even when the exit code is nonzero. Keep `--timeout` shorter than your own shell tool's time limit; on `timeout`, simply wait again.

| `outcome` | Exit | Meaning | What to do |
|---|---|---|---|
| `completed` | 0 | The CLI finished this exact task | Report `request.response` to the user |
| `attention` | 2 | The CLI is waiting for a human, e.g. `session.error` = `PERMISSION_REQUIRED` | Tell the user which session needs them in the desktop app; do not answer the prompt |
| `failed`, `interrupted` | 2 | The turn did not finish normally | Report it with `request.error`; decide on a new task only with the user |
| `timeout` | 3 | Still running when the wait ended | Wait again with the **same** request ID |

### When the CLI asks to trust the folder

A new folder makes the CLI ask whether to trust it, and Codex can also ask to review new or changed hooks. Then `wait` returns `attention` with `session.error` set to `TRUST_REQUIRED` or `HOOK_TRUST_REQUIRED`, and `session.trustFolder` names the folder. Tell the user once, for example: "Claude Code is waiting for you to trust `<trustFolder>` in Agent Harbor (Trust folder button, no need to take control)." Then wait with the **same** request ID and `--through-attention`, which keeps waiting while the human answers instead of returning `attention` at once:

```sh
"$HARBOR_NODE" "$HARBOR_CLI" wait <session-id> --request-id checkout-review-001 --through-attention --timeout 300000
```

The task starts by itself once they click, and the first task is not lost or repeated. Folders the user pre-authorized never stop here. If the user declines, the request ends `interrupted` with `TRUST_DECLINED` and no conversation exists. Do not retry unless the user asks.

### Other attention

After `attention`, the request stays `running` and new tasks fail with `TURN_PENDING`. You may read `capture` and tell the user, in this conversation, what the CLI is asking (for example which tool), but never answer it. Then either wait for the user to say they have handled it, or call `wait` on the same request ID with `--through-attention`: it returns `completed` (or another outcome) once the human has answered and the task finishes, or `timeout`.

`request.response` is the answer **only** when `request.status` is `completed` for your request ID. A live process, the terminal screen or the session's older responses are not proof that your task succeeded. `--timeout` accepts 0 to 3600000 milliseconds (default 120000).

## 4. Follow-up tasks

When the previous task completed and the session is ready, send the next one with a **new** request ID:

```sh
"$HARBOR_NODE" "$HARBOR_CLI" send <session-id> --actor grok --request-id checkout-review-002 \
  --text "Now list the three riskiest functions and explain why."
```

Then `wait` on that new request ID. Retrying `send` with the same request ID and identical text returns the existing receipt with `duplicate: true` and does not deliver the task twice. Reusing a request ID with different text fails with `REQUEST_ID_CONFLICT`: fix your bookkeeping instead of retrying.

`send` refuses with `TURN_PENDING` while a task is still running, `SESSION_STOPPED` if the CLI is closed, and `CONTROL_DENIED` if the human has control.

## 5. Stop and resume the same conversation

```sh
"$HARBOR_NODE" "$HARBOR_CLI" stop <session-id> --actor grok
"$HARBOR_NODE" "$HARBOR_CLI" resume <session-id> --actor grok --request-id checkout-review-003 \
  --text "Continue: propose a fix for the first risky function."
```

"Close" a session means `stop`. It asks the CLI to exit normally and returns `session.alive: false` and `status: stopped` once it has. It refuses with `TURN_PENDING` during a task. `STOP_TIMEOUT` means the CLI did not exit and nothing was force-killed: tell the user, and never report it as closed. `resume` relaunches the CLI on the **exact** saved conversation with the same Harbor session ID; wait on its request ID as usual. If resume fails with `SESSION_ID_UNVERIFIED` or `WORKTREE_MISSING`, the exact conversation cannot be recovered safely: stop and ask the human.

Only when the user asks: `archive <id>` hides a stopped session (it fails with `SESSION_ALIVE` while the CLI runs), `restore <id>` brings it back, and `rename <id> --title NAME` renames it. These are not ownership-checked, so never use them on the human's sessions unasked.

## 6. When the human takes control

The human can take any session in the desktop app at any time. From then on, every mutation you attempt fails with `CONTROL_DENIED` (or `CONTROL_CHANGED` if it happened mid-delivery). Stop writing, tell the user you are waiting for them, and keep only observing. A task delivered before the takeover is neither cancelled nor duplicated. Resume work only after the human returns control (the session's `owner` is `grok` again) or explicitly tells you to.

## 7. Observe without changing anything

These commands are always safe, whoever owns the session:

| Command | Returns |
|---|---|
| `list --compact` | Every session: `id`, `title`, `provider`, `project`, `owner`, `alive`, `status`, `pending`, `error`, `nativeSessionId`, timestamps, and `cliArgs` when it has startup arguments. Add `--archived` to include archived sessions |
| `result <id> --request-id <rid>` | The current session plus that request's receipt (`status`, `response`, `error`, `images`) |
| `capture <id>` | `screen`: the current terminal text. Use it to diagnose or to tell the user what a prompt asks; it is never proof that your task completed |
| `events <id> [--after <cursor>]` | Up to 200 observed CLI events and a `nextCursor` |

Do not use `watch` or `attach`: `watch` streams forever and `attach` is the human's interactive terminal.

`session.status` is one of `starting`, `ready` (idle, accepts a task), `running` (a task is in progress), `attention` (waiting for a human; reason in `session.error`), `stopped` (CLI closed, conversation saved) or `archived`. Immediately after a mutation, `request.status` is `awaiting_ack` for a newly launched CLI or `running` for `send`.

## 8. Images

Attach local PNG, JPEG or WebP files with repeated `--image /absolute/path.png` on `create`, `start`, `resume` or `send` (at most 8 files, 10 MiB each, 32 MiB total). Pass real files, not URLs or descriptions. Keep the files unchanged until the request is accepted; they are part of the request's identity. Details: [references/images.md](references/images.md).

## 9. Recovering from errors

Every failure is `{"ok": false, "error": {"code": ..., "message": ...}}`. The most common responses:

- `RPC_TIMEOUT`, disconnection, `uncertain`, `DELIVERY_UNCERTAIN`, `REQUEST_UNRESOLVED` → read `result` with the same request ID; never resend under a new ID.
- `CONTROL_DENIED`, `CONTROL_CHANGED` → the human owns the session; stop writing.
- `CLI_NOT_READY`, `HOOKS_NOT_READY`, session `status: attention` → the human must act in the terminal; tell them which session.
- `REQUEST_ID_CONFLICT`, `SESSION_ID_CONFLICT` → your bookkeeping reused an ID; correct it, do not create duplicates.

The full table is in [references/errors.md](references/errors.md).

## Reporting back

Tell the user which session (title and provider) did the work, quote or summarize `request.response`, and mention anything that blocked the task, such as a pending permission request. The Harbor session ID may be shown to the user when it helps them find the session; keep native conversation IDs and terminal contents out of anything public. Keep the session ID and request IDs in your notes for later follow-ups.

More background: [Grok Bot setup](https://github.com/TommyBez/agent-harbor/blob/main/docs/GROK-BOT.md), [supported CLI startup options](https://github.com/TommyBez/agent-harbor/blob/main/docs/STARTUP-OPTIONS.md).
