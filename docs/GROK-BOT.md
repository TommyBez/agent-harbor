# Using Harbor from Grok Bot

Grok Bot needs a local command-execution tool on the same Mac as Harbor. The integration is the Harbor CLI and its JSON responses. There is no hosted endpoint, additional provider API key or automatic permission bypass to configure.

The desktop app and the bot must use the same Harbor state directory. The default is the current user's `Library/Application Support/Agent Harbor` directory. If you choose `HARBOR_HOME`, set the same value for both. Different values intentionally create separate registries.

## Agent skill

The repository ships an [`agent-harbor` skill](../skills/agent-harbor/SKILL.md) that packages the rules below for any agent that loads skills: `npx skills add TommyBez/agent-harbor --skill agent-harbor`, or copy `skills/agent-harbor` into the agent's skills directory. The copyable instruction later on this page remains the option for bots without skill support.

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

Keep the app installed at that location while its daemon and hooks are in use. tmux and the authenticated provider CLIs remain external prerequisites. A source CLI and bundle CLI can share state, but the first client starts the daemon from its own installation; do not mix incompatible releases against one state directory. After an update, the first client of the newer release replaces the older controller automatically, and running CLIs are adopted unchanged. A `wait` interrupted by that replacement returns `DAEMON_DISCONNECTED`: wait again with the same request ID.

Folder trust and Codex hook review need a human decision once per folder (hook review again when the observer command changes, including a move from a source checkout to the packaged app). The human answers them with one click in Harbor, without taking control, or pre-authorizes the folder that holds their projects so Harbor answers them itself. The bot never answers them. See [workspace trust](WORKSPACE-TRUST.md). If a turn ran while hooks were untrusted, inspect the terminal rather than replaying it blindly; after approving the intended hooks, exit normally and resume with a new request ID for a new task. The packaged Codex resume was verified after this one-time setup.

Shell variables and functions may not survive between separate Grok tool calls. Either supply the resolved paths in every invocation or define them in each script. Quote paths and pass arguments as an array when the tool supports it. Never interpolate a task's text or project path into an unquoted shell command.

## Bot instruction to copy

Replace the two path placeholders and the project placeholder before adding this instruction to your bot. The project must be explicitly authorized by its owner. This instruction makes Grok a controller; it does not give it permission to answer trust or tool-approval prompts, or to change trusted folders.

```text
Use Agent Harbor to delegate local coding work to interactive Codex or Claude Code sessions.

Harbor Node executable: {{HARBOR_NODE}}
Harbor CLI file: {{HARBOR_CLI}}
Authorized project directory: {{PROJECT_DIRECTORY}}
Harbor state directory: use the desktop app's default unless the user explicitly configured the same HARBOR_HOME for both.

Invoke the Node executable with the CLI file followed by Harbor arguments. Use literal argument arrays where possible. First run doctor and inspect the JSON. Do not install dependencies, change credentials or change permissions merely to make the check succeed.

Before creating a session, generate and retain a UUID for --id. Retain its provider, project, title and any supported startup arguments. Use create with --owner grok and --text for the first task. Choose codex or claude according to the user's request. Multiple conversations can exist for either provider: never identify a session by provider alone.

For every task, generate and retain a request ID before sending it. Reuse that exact request ID and payload only for a retry of the same task. A different task gets a different request ID. Retain the returned Harbor session ID and native conversation ID in your task state.

To send images, supply repeated --image /absolute/file.png options on create, start, resume or send, or use images: [absolute paths] in a private --request-file JSON. Supply actual local PNG, JPEG or WebP files, not URLs, clipboard shortcuts or a description of the pixels. Keep source files stable until the request is accepted; use result to retrieve an existing receipt if the original files have gone away. The controller snapshots each image and includes its hash in request identity. Inspect request.images as well as request.response. Never resend an uncertain request with a new ID.

Use wait or result with both the Harbor session ID and request ID. Treat request.response as the answer only when the requested operation is completed. A process being alive, a terminal screenshot or an old lastResponse is not proof that this request succeeded. Report the provider's answer to the user with any relevant limitations.

Use send --actor grok for an already running, ready session. Use stop --actor grok only after the active turn finishes. Use resume --actor grok for the same saved conversation after its CLI exits. Resume must keep the same Harbor session ID; do not substitute create or a provider's latest conversation.

If control belongs to the human, stop submitting input. Do not claim --actor human or switch control back to grok without an explicit user instruction. Observation is allowed through list, result, events or capture. The desktop user takes control and returns it explicitly.

If a command times out or disconnects, inspect result using the same request ID. Do not assume that the task was not delivered. For uncertain delivery, preserve all IDs and ask the human to inspect the existing terminal; never resend with a new ID to get around the condition. For a request-ID conflict, correct your local bookkeeping instead of launching another task.

If Harbor reports TRUST_REQUIRED or HOOK_TRUST_REQUIRED, tell the user once that the session needs them to trust the folder or hooks in Agent Harbor, then wait with the same request ID and --through-attention: the task continues on its own after they click. Never run harbor trust or harbor trusted-folders. If Harbor reports other attention, login, permissions or an unavailable native identity, tell the user which session needs attention in the desktop app. Do not approve, bypass, type Enter into an unknown prompt, edit global settings or force-kill the CLI. After the user resolves the issue, recheck the existing request and session rather than creating a replacement.

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

## Images from the bot

Images are request data, separate from persistent CLI startup options. The same interface works for both providers and for `create`, `start`, `send` and `resume`:

```sh
"$HARBOR_NODE" "$HARBOR_CLI" send "$SESSION_ID" \
  --actor grok --request-id visual-review-001 \
  --text "Compare these two screenshots and identify the changes." \
  --image "/absolute/path/before.png" \
  --image "/absolute/path/after.png"
```

For long prompts or paths that need escaping, write a private JSON file and invoke `send --request-file /absolute/request.json`. Request files also support `create`, `start` and `resume`; their `id` is included in the JSON rather than supplied as another argument:

```json
{
  "id": "40f3177c-95c2-47e6-a960-6833667fd203",
  "actor": "grok",
  "requestId": "visual-review-001",
  "text": "Describe the attached screenshot.",
  "images": ["/absolute/path/screenshot.png"]
}
```

Harbor accepts up to **8 images**, **10 MiB per file** and **32 MiB total**, with PNG, JPEG or WebP headers. Files must be regular, absolute local paths; symbolic links, directories, URLs, control characters and unsupported formats are rejected. The provider still performs full decoding and can impose its own limits. Image-only requests use a short description prompt by default. Live validation currently covers PNG; JPEG and WebP are accepted formats, not yet live-certified cases.

The controller copies the captured bytes into private, content-addressed storage under its state directory. Copies stay available for retries and native conversation history; there is no automatic attachment garbage collection in this release. Hashes and file metadata appear in `request.images`, never image base64 in ordinary JSON responses. Reusing a request ID with changed text, file bytes, path or image order is a conflict. Preserve the original source files when retrying a mutation; retrieving `result` does not need them.

Codex launch/resume uses its native `--image` flags. In an already-open Codex session, Harbor pastes each staged path separately, checks the current composer for the attachment marker, then submits the text. Claude uses its native quoted `@file` mentions, which load image content before inference. These routes preserve the original interactive CLI and use **no shared system clipboard or desktop keyboard shortcuts**. Provider settings that disable file mentions can affect Claude; normal provider settings and permissions remain in force.

An older controller is rejected with `DAEMON_UPGRADE_REQUIRED` before a client sends an image mutation. Attachment or control failures after delivery preparation leave an uncertain receipt and an unsubmitted draft to inspect; Harbor does not silently send text alone or replay the task. The composer check is an input preflight only: completion and response attribution still require the native hooks.

## Results, errors and retries

| Result or error | Meaning | Bot response |
|---|---|---|
| `ok: true` with `intent`, `delivering`, `awaiting_ack` or `running` | Operation accepted or underway; no completed answer yet | Wait for that request |
| `completed` | The request reached an observed completion | Read that request's response; do not substitute another session's output |
| `failed` or `interrupted` | The turn did not complete normally | Report the cause and preserve context before deciding another task |
| `uncertain`, `DELIVERY_UNCERTAIN`, `RPC_TIMEOUT`, disconnection | Delivery may have occurred | Retrieve the same receipt; do not blindly replay |
| `CONTROL_DENIED` or `CONTROL_CHANGED` | Human ownership or a changed control epoch | Stop writing and let the human resolve ownership/draft |
| `TURN_PENDING`, `SESSION_CLOSING` | Current interaction has not reached a ready boundary | Wait or inspect the same operation; in a bot-owned session, `send --steer` corrects and `interrupt` stops the running turn |
| `NO_ACTIVE_TURN`, `CLI_WAITING_FOR_HUMAN`, `INTERRUPT_UNCONFIRMED` | Steer or interrupt refused: nothing running, a dialog for the human is open, or the CLI did not confirm Esc | Use a plain send; tell the user about the dialog; inspect the terminal |
| `REQUEST_UNRESOLVED` | A previous delivery in this process still has no confirmed receipt | Inspect that receipt and terminal; a new task is blocked to prevent ambiguous attribution |
| `TRUST_REQUIRED`, `HOOK_TRUST_REQUIRED` | The CLI waits for folder trust or Codex hook review | Ask the user to click Trust in Harbor; `wait --through-attention` on the same request ID |
| `TRUST_DECLINED` | The human declined; no conversation was created | Report it; start again only if the user asks |
| `TURN_SUPERSEDED` (request) | The human interrupted and typed their own prompt | Report it; do not resend unless asked |
| `CLI_NOT_READY`, attention state, `HOOKS_NOT_READY` | Unrecognized dialog, hooks, permission or other observed readiness problem | Direct the user to the existing terminal |
| `REQUEST_ID_CONFLICT`, `SESSION_ID_CONFLICT` | A retained identity was reused for different input | Correct bookkeeping; do not create duplicates to hide the error |
| `SESSION_ID_UNVERIFIED`, `WORKTREE_MISSING` | Exact recovery cannot safely proceed | Preserve the session and request human repair |
| `STOP_TIMEOUT` | Normal exit was not confirmed; Harbor did not force-kill | Inspect the terminal; never report the CLI as closed |
| `INVALID_IMAGES`, `INVALID_IMAGE`, `IMAGE_UNREADABLE`, `IMAGES_TOO_LARGE` | Image input is invalid or unavailable | Correct the file input before a new operation |
| `DAEMON_UPGRADE_REQUIRED` | Active controller cannot handle images | Upgrade the controller before sending; the client did not submit the image mutation |
| `IMAGE_COMPOSER_NOT_READY`, `IMAGE_ATTACH_UNCONFIRMED` | Image attachment could not be confirmed | Inspect the existing draft and receipt; never submit or replay blindly |
| `UNSUPPORTED_CLI_ARGUMENT`, `RESERVED_CLI_ARGUMENT` | Startup option is unsupported or conflicts with Harbor's contract | Explain the boundary; do not bypass the validator |

`wait` exits with code 0 for completion, 3 for timeout and 2 for other non-completed outcomes. Other command failures use a nonzero exit and an error object. Inspect the JSON even when the shell returns a nonzero status. `watch` is a long-running subscription, not a task completion command.

Normal creation with no `--text` and no images records a stopped session; call `start` to launch it. An image-only creation starts with a neutral description prompt. The desktop can also create, select, take over, stop, resume and restore sessions. The machine API's control commands are local coordination, not authentication against other processes running as the same OS user.

## Verification boundary

The copyable instruction and commands describe the integration contract. The [2026-10-17 verification record](VERIFICATION.md) also records an observed real Grok Bot run: the Codex Lab bot displayed the successful result for two Claude and two Codex conversations after analysis, actual CLI exit and exact-conversation resume. This proves the tested local bot configuration and scenario; it does not automatically verify another installation. Local scripted tests, native UI tests and the real Grok chat remain separate evidence layers.

The image checkpoint additionally confirms the actual bot created, sent images to, stopped and resumed one conversation per provider, with six accepted/completed responses returned to its chat. Native histories contained the image blocks, and both providers recalled prior image numbers after resume. See [image verification](VERIFICATION.md#images-from-grok-bot-passed).
