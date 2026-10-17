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
