# Using Harbor from Grok Bot

Grok Bot needs a local command-execution tool on the same Mac as Harbor. The integration is the Harbor CLI and its JSON responses. There is no hosted endpoint, additional provider API key or automatic permission bypass to configure.

The desktop app and the bot must use the same Harbor state directory. The default is the current user's `Library/Application Support/Agent Harbor` directory. If you choose `HARBOR_HOME`, set the same value for both. Different values intentionally create separate registries.

## Choose a portable command path

Use one of these setups. The paths are examples based on installation layout, not paths tied to a developer's account.

### From a source checkout

Run this from the repository root after installing dependencies. Node 24 or later is required:

```sh
HARBOR_NODE="$(command -v node)"
HARBOR_CLI="$PWD/bin/harbor.mjs"
"$HARBOR_NODE" "$HARBOR_CLI" doctor
```

Give the bot the resolved executable and CLI paths. Its future working directory need not be the checkout. Keep the checkout at that location while its daemon and observational hooks are in use.

### From the packaged desktop app

The bundle includes Node and the Harbor client. Adjust the app location if installed elsewhere:

```sh
HARBOR_APP="/Applications/Agent Harbor.app"
HARBOR_NODE="$HARBOR_APP/Contents/Resources/runtime/node"
HARBOR_CLI="$HARBOR_APP/Contents/Resources/harbor/bin/harbor.mjs"
"$HARBOR_NODE" "$HARBOR_CLI" doctor
```

Keep the app installed at that location while its daemon and hooks are in use. tmux and the authenticated provider CLIs remain external prerequisites. A source CLI and bundle CLI can share state, but the first client starts the daemon from its own installation; do not mix incompatible releases against one state directory. Stop agents normally and follow a documented upgrade procedure before replacing resources used by live sessions.

Shell variables and functions may not survive between separate Grok tool calls. Either supply the resolved paths in every invocation or define them in each script. Quote paths and pass arguments as an array when the tool supports it. Never interpolate a task's text or project path into an unquoted shell command.

## Bot instruction to copy

Replace the two path placeholders and the project placeholder before adding this instruction to your bot. The project must be explicitly authorized by its owner. This instruction makes Grok a controller; it does not give it permission to accept new CLI trust or tool-approval prompts.

```text
Use Agent Harbor to delegate local coding work to interactive Codex or Claude Code sessions.

Harbor Node executable: {{HARBOR_NODE}}
Harbor CLI file: {{HARBOR_CLI}}
Authorized project directory: {{PROJECT_DIRECTORY}}
Harbor state directory: use the desktop app's default unless the user explicitly configured the same HARBOR_HOME for both.

Invoke the Node executable with the CLI file followed by Harbor arguments. Use literal argument arrays where possible. First run doctor and inspect the JSON. Do not install dependencies, change credentials or change permissions merely to make the check succeed.

Before creating a session, generate and retain a UUID for --id. Retain its provider, project, title and any supported startup arguments. Use create with --owner grok and --text for the first task. Choose codex or claude according to the user's request. Multiple conversations can exist for either provider: never identify a session by provider alone.

For every task, generate and retain a request ID before sending it. Reuse that exact request ID and payload only for a retry of the same task. A different task gets a different request ID. Retain the returned Harbor session ID and native conversation ID in your task state.

Use wait or result with both the Harbor session ID and request ID. Treat request.response as the answer only when the requested operation is completed. A process being alive, a terminal screenshot or an old lastResponse is not proof that this request succeeded. Report the provider's answer to the user with any relevant limitations.

Use send --actor grok for an already running, ready session. Use stop --actor grok only after the active turn finishes. Use resume --actor grok for the same saved conversation after its CLI exits. Resume must keep the same Harbor session ID; do not substitute create or a provider's latest conversation.

If control belongs to the human, stop submitting input. Do not claim --actor human or switch control back to grok without an explicit user instruction. Observation is allowed through list, result, events or capture. The desktop user takes control and returns it explicitly.

If a command times out or disconnects, inspect result using the same request ID. Do not assume that the task was not delivered. For uncertain delivery, preserve all IDs and ask the human to inspect the existing terminal; never resend with a new ID to get around the condition. For a request-ID conflict, correct your local bookkeeping instead of launching another task.

If Harbor reports attention, missing hook trust, login, permissions or an unavailable native identity, tell the user which session needs attention in the desktop app. Do not approve, bypass, type Enter into an unknown prompt, edit global settings or force-kill the CLI. After the user resolves the issue, recheck the existing request and session rather than creating a replacement.

Use only the user's authorized project and scope. Do not archive sessions or remove files unless the user asks. Never publish runtime transcripts, credentials, native IDs or private project paths as debugging evidence.
```

## Command sequence

The following is a shell example. Replace the authorized project path and retain the generated session/request values outside transient tool output before retrying a mutation. Use the path setup above in the same shell invocation, or substitute the resolved quoted paths.

```sh
SESSION_ID="$("$HARBOR_NODE" -e 'console.log(require("node:crypto").randomUUID())')"
REQUEST_ID="initial-analysis-001"

"$HARBOR_NODE" "$HARBOR_CLI" create \
  --id "$SESSION_ID" --provider claude \
  --project "/absolute/path/to/authorized/project" \
  --title "Project analysis" --owner grok \
  --text "Read this project and summarize its structure. Do not modify files." \
  --request-id "$REQUEST_ID"

"$HARBOR_NODE" "$HARBOR_CLI" wait "$SESSION_ID" --request-id "$REQUEST_ID" --timeout 120000
"$HARBOR_NODE" "$HARBOR_CLI" result "$SESSION_ID" --request-id "$REQUEST_ID"
```

Do not execute the whole lifecycle blindly. Inspect each result before the next mutation. After completion, a later task in the active process uses `send` with a new request ID. After a verified normal stop, use `resume` with a new request ID and the same session ID. The provider value `codex` uses the same Harbor contract.

## Results, errors and retries

| Result or error | Meaning | Bot response |
|---|---|---|
| `ok: true` with `intent`, `delivering`, `awaiting_ack` or `running` | Operation accepted or underway; no completed answer yet | Wait for that request |
| `completed` | The request reached an observed completion | Read that request's response; do not substitute another session's output |
| `failed` or `interrupted` | The turn did not complete normally | Report the cause and preserve context before deciding another task |
| `uncertain`, `DELIVERY_UNCERTAIN`, `RPC_TIMEOUT`, disconnection | Delivery may have occurred | Retrieve the same receipt; do not blindly replay |
| `CONTROL_DENIED` or `CONTROL_CHANGED` | Human ownership or a changed control epoch | Stop writing and let the human resolve ownership/draft |
| `TURN_PENDING`, `SESSION_CLOSING` | Current interaction has not reached a ready boundary | Wait or inspect the same operation |
| `CLI_NOT_READY`, attention state, `HOOKS_NOT_READY` | Trust, hooks, permission or other observed readiness problem | Direct the user to the existing terminal |
| `REQUEST_ID_CONFLICT`, `SESSION_ID_CONFLICT` | A retained identity was reused for different input | Correct bookkeeping; do not create duplicates to hide the error |
| `SESSION_ID_UNVERIFIED`, `WORKTREE_MISSING` | Exact recovery cannot safely proceed | Preserve the session and request human repair |
| `STOP_TIMEOUT` | Normal exit was not confirmed; Harbor did not force-kill | Inspect the terminal; never report the CLI as closed |
| `UNSUPPORTED_CLI_ARGUMENT`, `RESERVED_CLI_ARGUMENT` | Startup option is unsupported or conflicts with Harbor's contract | Explain the boundary; do not bypass the validator |

`wait` exits with code 0 for completion, 3 for timeout and 2 for other non-completed outcomes. Other command failures use a nonzero exit and an error object. Inspect the JSON even when the shell returns a nonzero status. `watch` is a long-running subscription, not a task completion command.

Normal creation with no `--text` records a stopped session; call `start` to launch it. The desktop can also create, select, take over, stop, resume and restore sessions. The machine API's control commands are local coordination, not authentication against other processes running as the same OS user.

## Verification boundary

The copyable instruction and commands describe the integration contract. The [2026-10-17 verification record](VERIFICATION.md) also records an observed real Grok Bot run: the Codex Lab bot displayed the successful result for two Claude and two Codex conversations after analysis, actual CLI exit and exact-conversation resume. This proves the tested local bot configuration and scenario; it does not automatically verify another installation. Local scripted tests, native UI tests and the real Grok chat remain separate evidence layers.
