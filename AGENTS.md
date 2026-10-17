# Agent Harbor

Read `docs/ARCHITECTURE.md` and `docs/UX-RESEARCH.md` before changing behavior.

## Official Native SDK skills

Start with `.agents/skills/native-sdk/SKILL.md` and `.agents/skills/core/SKILL.md`.
- Native UI: `.agents/skills/native-ui/SKILL.md`
- Running app verification: `.agents/skills/automation/SKILL.md`
- Zig 0.16: `.agents/skills/zig/SKILL.md`
- TypeScript cores: `.agents/skills/ts-core/SKILL.md`

These are official upstream skills pinned to the SDK release; do not rewrite them to describe this app. See `docs/NATIVE-SKILLS.md`.

## Product invariants

- Run the original interactive CLIs. Preserve user configuration and normal permission/trust checks.
- Session UUID, native conversation ID, process run ID and request ID are distinct. Never resume by "latest".
- Closing a window must not stop sessions. Explicit stop must not silently force-kill an agent.
- Human and bot input is exclusive inside the controller. Never let bot retries duplicate a delivered prompt.
- Runtime data, transcripts, credentials and machine-specific configuration stay outside source control.
- List and terminal behavior must work for multiple sessions of the same provider, with no fixed two-session model.
- Use subprocess argument arrays; no interpolation of user paths or prompts into shell code.
- No public network listener. The local IPC boundary is the current OS account, not a sandbox against that account.

## Validation

Use pnpm. Run backend tests, native model tests, markup checks and native build for relevant changes. Verify actual UI paths through Native SDK automation; a build alone is not product evidence. Real agent tests require authenticated local CLIs and run only against an explicitly selected fixture/project. Keep public verification evidence redacted.
