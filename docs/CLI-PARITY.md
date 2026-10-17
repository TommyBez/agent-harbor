# CLI capability preservation

Agent Harbor runs the original interactive Claude Code and Codex CLIs. The goal is to retain their normal behavior while adding persistent sessions, an overview and explicit human/bot control. This architecture minimizes replacement of CLI behavior; it does **not** prove universal feature parity.

## What stays with the CLI

- Authentication, subscription/provider access and model availability.
- Project instructions, skills, plugins, MCP connections and user settings.
- Tool approval policies, project trust and permission dialogs.
- Interactive slash commands, menus, conversation compaction and provider-specific features.
- Native conversation persistence and exact-ID resume.

Harbor does not copy these into its own settings UI or replace the interactive process with a simplified chat API. It adds observational hooks for correlation and does not change global configuration, grant permissions or bypass trust. Provider updates can change terminal behavior or hook contracts; support must be rechecked rather than inferred from an older version.

## Startup options

Original CLI startup options can be supplied at session creation using `--cli-args` with a JSON array or repeated `--cli-arg` values. The array is stored and reused. The provider-specific allowlist in `broker/arguments.mjs` is the current source of truth; it includes model selection, supported configuration options, additional directories and provider worktree options.

This is not universal flag pass-through. Harbor reserves options that change native conversation identity, bypass trust/permissions, replace observation hooks, select headless output, move execution to another environment, or otherwise conflict with interactive local persistence. Unknown flags return `UNSUPPORTED_CLI_ARGUMENT`; managed flags return `RESERVED_CLI_ARGUMENT`. A provider update can add a new compatible option that still requires Harbor support. Do not claim support for every current or future CLI flag.

A first-launch worktree can become the saved working directory when observed events confirm that it belongs to the same Git repository. Resume reuses that directory and skips creating another worktree. A missing saved worktree is an explicit recovery error. Stop/archive do not delete its files.

## Three different claims

1. **The original process runs.** Its normal code and configuration are available.
2. **The terminal transport carries a feature correctly.** PTY, tmux, terminal renderer and OS integration all matter.
3. **The feature has been verified in Harbor.** This requires a dedicated test and evidence.

The first claim does not automatically establish the other two. For example, an image-paste shortcut can exist in a CLI while a particular embedded terminal does not forward image clipboard data in the required way.

## Embedded terminal and external terminal fallback

The desktop interface renders the selected original CLI through a terminal attachment. A view-only attachment must not send keys or change the agent's control owner. The user explicitly takes control before typing.

The intended fallback is **Open in Terminal** (Italian UI: **Apri in Terminale**): attach the same tmux session in the user's terminal after transferring control to the human. This must preserve the existing process and native conversation; opening a new Claude or Codex process is not an equivalent fallback.

Use the fallback when an embedded-terminal limitation affects image clipboard input, an input method editor, complex key combinations, external editors or terminal-specific integrations. A fallback does not waive verification: tmux and the chosen external terminal can also affect these capabilities. The UI should explain which session will open, keep ownership visible, and make returning control to Grok explicit. If the CLI is closed, resume the saved conversation first rather than attaching a nonexistent process.

## Capability matrix

Status refers to the [2026-10-17 verification checkpoint](VERIFICATION.md). A live pass covers only the stated scenario. Pending and partial entries must not be described as full capability certification.

| Capability | Expected route | Evidence required | Status |
|---|---|---|---|
| Normal interactive CLI | Original installed binary in a PTY | Actual provider TUI and native hook execution | Live four-session scenario passed; packaged app rendered real terminals through 12 session switches |
| Project analysis and tools | Original working directory and settings | Reads fixture, executes meaningful tests and returns attributed output | Live pass: 2/2 tests in each of four sessions |
| Multiple concurrent conversations | Independent Harbor/run/native IDs | At least two sessions of each provider, no crossed output | Live pass: two Codex + two Claude conversations |
| Native resume | Explicit saved provider ID | Process exits; new PID recalls prior context under same native ID | Live pass: all four, with no tools in recall turns |
| Startup options | Validated provider argument array | Supported options retained; reserved flags rejected without launching | Automated pass: literal arguments persist across store reopen and resume; lifecycle, permission and hook-disabling variants are rejected. Provider acceptance of every allowed option remains unverified |
| Provider worktree | Observed same-repository directory | Resume uses saved directory and preserves its files | Pending |
| GUI persistence | tmux owns process lifetime | Close/reopen GUI while original PID survives | Four processes survived GUI closure/reopen; final app and bundled replacement daemon adopted the same live processes |
| Slash commands and menus | Terminal keystrokes | Navigate a real provider menu without intercepted keys | Codex hook review, trust and /exit menu exercised through the native terminal; broader menus remain unverified |
| Interrupt | Terminal input while human owns it | Ctrl-C reaches the intended CLI and state is reported correctly | Pending |
| Multiline paste | PTY/tmux bracketed paste | Text, line breaks and submission count preserved | Specific multiline input passed through native UI on one Claude and one Codex conversation |
| Unicode and emoji | Renderer and terminal encoding | Correct content and cursor placement | Accented text and emoji content passed on both providers; general cursor/Unicode edge cases pending |
| IME composition | Embedded terminal or external terminal fallback | Composition commits correctly without duplicate input | Pending |
| Image clipboard | Provider + terminal/OS integration | Image reaches the original conversation and model reads its unseen contents | Partial live pass: **Ctrl+Shift+V** attached a copied PNG in both CLIs; both described it correctly without tools. Cmd+V and Ctrl+V attached nothing in Native SDK 0.6.2. See [image-paste evidence](VERIFICATION.md#image-clipboard-partial-live-pass) |
| Bot image requests | Per-request `--image` or JSON `images` | Native image content, attributed response, no shared clipboard; same conversation after resume | Real Grok create/send/stop/resume passed on both providers, including visual recall; separate multiple-PNG controller checks passed |
| Image drag/drop | Provider + terminal/OS integration | Dropped image reaches the intended conversation | Pending |
| Resize and alternate screen | Selected terminal attachment | Repeated resize, menus and redraw remain usable | Pending |
| Selection and scrollback | Native terminal surface | Copy, scrolling and returning to live output work | Pending |
| External editor/subprocess | CLI launching its normal tools | Return to same conversation after interactive child exits | Pending |
| Skills, plugins and MCP | Existing provider configuration | Representative installed extension works unchanged | Pending |
| User/project hooks | Invocation-local observation added to existing hooks | Existing hook still executes and can retain its normal decisions | Partial: Codex registry aggregation verified; Claude documented merge; execution coverage pending |
| Permission/trust prompts | Original provider UI | New-project trust and tool approvals remain visible and effective | Normal trust UI observed; comprehensive policy/tool-prompt cases pending |
| Bot/human handoff | Controller owner + tmux client writability | No wrong-owner input; same conversation continues | Passed on one session per provider: human UI input, Passa a Grok, real bot follow-up and recalled answer under unchanged native ID/PID |
| External terminal handoff | Same tmux session | Same PID/native ID, human input, then safe return to bot | Partial: UI button attached a second client to the existing Codex conversation/process; external typing/menu and return unverified |
| Provider update compatibility | Version probe + regression suite | Hook correlation and terminal smoke test on each declared version | Pending |

## Honest failure behavior

- Missing CLI, authentication or dependency: display the actionable cause; do not substitute another provider.
- Missing hook trust or blocked observation: keep the original terminal accessible and report that structured readiness/results are unavailable.
- Lost native identity: do not resume “latest” or silently create a different conversation.
- Uncertain prompt delivery: preserve its receipt and require reconciliation; do not replay automatically.
- A running turn: do not label it ready merely because there is a final-looking line on screen.
- A terminal capability not yet tested: label it unverified. Document a tested workaround only after exercising the same conversation through that route.

See [architecture and recovery contracts](ARCHITECTURE.md). A release can claim the capabilities its evidence demonstrates; this matrix is not a full parity certification.
