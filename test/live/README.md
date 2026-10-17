# Live validation with the original CLIs

This scenario starts **four real interactive sessions**: two Codex and two Claude Code. It uses the existing authentication and normal CLI permissions. It never accepts trust prompts, changes global configuration, or bypasses permissions. Only run it after selecting the fixture and the private Harbor state directory explicitly.

```sh
node test/live/scenario.mjs \
  --project "$PWD/test/fixtures/workspace" \
  --home "$HOME/Library/Application Support/Agent Harbor"
```

The project must contain this repository's invoice fixture. The script asks the four agents to read it without editing it and run its two Node tests. Native hook evidence must confirm the successful test command; a self-reported result is insufficient.

Each conversation gets a different random marker. The scenario tests human ownership by confirming that Grok input is rejected, restores Grok ownership, closes all four CLI processes, verifies their old PIDs are absent together, and resumes the exact native conversations with new processes. Resume prompts contain neither the marker nor the expected test answer. A tool invocation in the resume turn fails the memory test.

The four resumed sessions remain available in the desktop app at the end. Sessions that existed before this scenario are left alone.

## Retry and evidence

A private `live-scenario.local.json` checkpoint lives under `--home`. Creation UUIDs and request IDs are persisted before any effect. If interrupted, repeat **the exact same command**. Never delete the checkpoint to get around an error, and never rerun the task manually with a different request ID. If the application reports an uncertain delivery, inspect its terminal; the runner will not manufacture a new request.

Normal trust, authentication, hook review, and tool-permission prompts may pause the scenario. Resolve them in the desktop app, then repeat the same command. A second invocation after success only returns the saved result.

`live-summary.json` in the same directory is an intentionally sanitized publication summary. It contains booleans and counts, with no project paths, prompts, marker values, native IDs, or assistant responses. Review it before publishing. The checkpoint contains private evidence and must not be committed.

Optional `--checkpoint PRIVATE_PATH` and `--report PATH` select alternative outputs. Both must remain outside the fixture. A new checkpoint creates new sessions; it does not reuse another run's sessions.

The scenario covers CLI exit/resume, routing, test execution, response delivery and ownership. GUI close/reopen, a real bot's chat UI, daemon restart, packaging, keyboard/clipboard behavior, and Mac reboot require separate evidence.

## Image requests from a real bot

Use the contract in [GROK-BOT.md](../../docs/GROK-BOT.md#images-from-the-bot) with a trusted fixture and the installed interactive providers. Check `doctor.capabilities.requestImages === 1` first. Keep all test files, request JSON and raw receipts in a private ignored directory.

1. Prepare three PNG images containing different random numbers and different colored shape counts. Keep expected answers separate from prompts and bot instructions.
2. Persist one new session UUID per provider and three stable request IDs before calling the bot. Prepare `create`, `send` and `resume` JSON files; each contains one image path. Ask for image description without tools. In the second turn also ask for the first number; after resume ask for both previous numbers without including those answers.
3. Ask the actual Grok bot to execute each JSON through `--request-file`, wait for that exact receipt, and report its response. Between send and resume, stop the CLI and verify `alive: false`.
4. Read back all six receipts: accepted, completed, correct image manifest, correct visual answers and correct recall. Verify the native conversation ID is unchanged, the resumed run has a different PID and the old process is gone. Inspect native histories for real image content and observer events for absence of tool calls in the image turns.
5. Confirm the answers in the actual Grok chat and in the selected desktop terminals. Record these separately from scripted RPC tests. Stop on attention or uncertain delivery and preserve the existing request; never replay it with a new ID.

Also exercise two images in one `send` on each provider. This covers the live Codex attachment path as well as Claude file mentions. JPEG/WebP and other clipboard formats need their own live evidence; a successful PNG test does not certify them.
