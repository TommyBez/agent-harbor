# Agent Harbor results and errors

Every command prints one JSON object. Failures are `{"ok": false, "error": {"code": "...", "message": "..."}}` with a nonzero exit code. Inspect the JSON before deciding anything; the exit code alone is not enough.

## Request statuses

| `request.status` | Meaning | Bot response |
|---|---|---|
| `intent`, `delivering`, `awaiting_ack`, `running` | Accepted or underway; no answer yet | `wait` on the same request ID |
| `completed` | The CLI finished this exact task | `request.response` is the answer |
| `failed`, `interrupted` | The turn did not finish normally | Report `request.error`; agree with the user before a new task |
| `uncertain` | Delivery may or may not have happened | Keep all IDs; ask the human to inspect the terminal; never resend with a new ID |

## Error codes

| Code | Meaning | Bot response |
|---|---|---|
| `RPC_TIMEOUT`, `DAEMON_DISCONNECTED`, connection errors | The reply was lost; the operation may still have happened | Run `result` with the same request ID before anything else |
| `DELIVERY_UNCERTAIN`, `DAEMON_RESTARTED_DURING_DELIVERY` | Harbor cannot prove whether the text reached the CLI | Ask the human to inspect the terminal; do not replay. The session keeps reporting it, even after the CLI accepts a later, different prompt, until that request's own prompt is accepted or the CLI exits. New bot tasks stay blocked with `REQUEST_UNRESOLVED` |
| `REQUEST_UNRESOLVED` | An earlier delivery in this process still has no receipt | Inspect that receipt; new tasks stay blocked to avoid mixing answers |
| `CONTROL_DENIED` | The other owner controls the session (or `--actor` was omitted) | Stop writing; never switch control yourself |
| `CONTROL_CHANGED` | Control changed while a task was being prepared; nothing was submitted | Stop; the human resolves the leftover draft |
| `TURN_PENDING` | A task is still running, or the human's turn is unfinished | `wait` for it; to correct or stop it in your own session, use `send --steer` or `interrupt` |
| `NO_ACTIVE_TURN` | `send --steer` or `interrupt` while nothing is running | Use a plain `send` |
| `CLI_WAITING_FOR_HUMAN` | A dialog is open; typing or Esc would answer it | Tell the user what the CLI is asking; never answer it |
| `INTERRUPT_UNCONFIRMED` | Esc was sent but the CLI did not confirm the interrupt; nothing was changed | Read `capture`, tell the user, do not resend the task |
| `INTERRUPTED` (in `request.error`, status `interrupted`) | You (or the owner) interrupted that request | Expected after `interrupt`; send the next task with a new request ID |
| `SESSION_CLOSING` | The CLI is exiting | Wait, then `resume` if needed |
| `SESSION_STOPPED` | The CLI is not running | `resume --actor grok` with a new request ID |
| `SESSION_ARCHIVED` | The session is archived | Tell the user; run `restore` only if they ask |
| `SESSION_ALIVE` | `archive` was attempted while the CLI is running | `stop` it first, and only if the user asked to archive |
| `TRUST_REQUIRED`, `HOOK_TRUST_REQUIRED` (in `session.error`) | The CLI asks to trust the folder (`session.trustFolder`) or, in Codex, to trust new or changed hooks | Tell the user once to click Trust in Agent Harbor; then `wait --through-attention` with the same request ID |
| `TRUST_DECLINED` (in `request.error` and `session.error`) | The human declined trust; no conversation was created | Report it; `start` again with a new request ID only if the user asks |
| `TRUST_HELPER_FAILED` (in `request.error`) | Harbor could not open Claude's trust dialog for a worktree launch; no conversation was created | Report it; the human checks `doctor` and the terminal |
| `TRUST_HUMAN_ONLY` | `trust` or `trusted-folders --add/--remove` was run as the bot | Never run these commands; the human decides |
| `CLI_NOT_READY`, `HOOKS_NOT_READY`, session `status: attention` | Login, permission, an unrecognized dialog or hook observation is pending in the terminal | Tell the user which session needs them; do not approve |
| `PERMISSION_REQUIRED`, `CLI_ATTENTION_REQUIRED` (in `session.error`) | The agent is waiting for a human decision | Same as above |
| `PROMPT_NOT_ACKNOWLEDGED` (in `session.error`) | The task was sent but the CLI never accepted it | Ask the human to check the terminal before retrying |
| `TURN_STATE_UNKNOWN` (in `session.error`) | After an update, Harbor could not confirm the session's last turn | Read `result` for your request; tell the user to check the terminal (an idle CLI needs them to send a message) and wait with `wait --through-attention`; never resend |
| `RESULT_NOT_OBSERVED` (in `request.error`) | Harbor never saw how that turn ended, so it has no answer for it | Tell the user; the answer may be visible in the terminal |
| `TURN_SUPERSEDED` (in `request.error`, status `interrupted`) | The human interrupted the turn and typed their own prompt | Report it; do not resend the task unless the user asks |
| `STOPFAILURE` (in `session.error`) | Claude stopped on an account or credential problem (billing, login, model access) | Tell the user; it needs them. Transient API errors (`overloaded`, `server_error`, `max_output_tokens`) leave the session `ready` with the error on `request.error`; usage limits (`rate_limit`) keep it in attention |
| `REQUEST_ID_CONFLICT` | The request ID was used before with different text or images | Fix your bookkeeping; a new task needs a new ID |
| `SESSION_ID_CONFLICT` | The session ID exists with a different provider, project, title or options | Use the right ID; do not create a lookalike |
| `REQUEST_ID_REQUIRED` | `wait` needs `--request-id` | Pass the request ID you recorded |
| `SESSION_ID_UNVERIFIED` | The last run never confirmed its native conversation, so exact resume is unsafe | Stop; the human repairs it |
| `WORKTREE_MISSING` | The saved working directory no longer exists | Stop; Harbor never resumes in a different folder |
| `STOP_TIMEOUT` | The CLI did not exit; nothing was force-killed | Tell the user; never report the CLI as closed |
| `INVALID_PROJECT` | The project path is not an existing directory | Ask for the correct authorized path |
| `INVALID_PROVIDER`, `INVALID_ACTOR`, `INVALID_OPTION`, `INVALID_TIMEOUT` | Malformed command | Fix the arguments |
| `INVALID_CLI_ARGS`, `UNSUPPORTED_CLI_ARGUMENT`, `RESERVED_CLI_ARGUMENT` | A startup option is unsupported or conflicts with Harbor | Explain the limit; do not work around the validator |
| `DEPENDENCY_MISSING` | tmux or the provider CLI was not found | Report `doctor` output; do not install software unasked |
| `UNSUPPORTED_NODE` | The CLI ran on Node.js older than 24 | Use the app's bundled Node or a newer Node |
| `INVALID_IMAGES`, `INVALID_IMAGE`, `INVALID_IMAGE_PATH`, `IMAGE_UNREADABLE`, `IMAGES_TOO_LARGE`, `IMAGE_CHANGED` | An image input is invalid, missing, too big or changed during capture | Fix the files before a new operation |
| `IMAGE_COMPOSER_NOT_READY`, `IMAGE_ATTACH_UNCONFIRMED` | Harbor could not confirm the image attachment; nothing was submitted | Treat like an uncertain delivery: inspect, never replay blindly |
| `DAEMON_UPGRADE_REQUIRED` | The running controller is too old for images | Ask the user to update Agent Harbor; nothing was sent |

## Exit codes of `wait`

`0` completed · `2` attention, failed or interrupted · `3` timeout · `1` command error.
