# Desktop smoke with isolated fake providers

This test drives the **real Native SDK desktop UI** through its automation protocol. It uses a deterministic interactive fake in place of Codex and Claude, so it makes no AI requests and accepts no trust prompts. Provider behavior and real Grok integration require the separate live scenario.

Use a new, short, absolute home for each run. Preparation refuses nonempty directories and never starts a daemon or application:

```sh
node test/live/desktop-smoke.mjs --prepare --home /private/tmp/harbor-ui-example
```

Start the latest automation-enabled app yourself, setting `HARBOR_HOME` to that exact directory. A packaged application uses `HOME/desktop` as its automation working directory. A development application normally uses this repository's `app` directory. Avoid opening two applications against the same automation directory.

Then run with the matching Native SDK executable and the directory containing `.zig-cache/native-sdk-automation`:

```sh
node test/live/desktop-smoke.mjs --run \
  --home /private/tmp/harbor-ui-example \
  --cwd /private/tmp/harbor-ui-example/desktop \
  --native /absolute/path/to/native
```

The preparation installs a private configuration and wrapper pointing to this checkout's `test/backend/fake-cli.mjs`, using the Node executable that ran preparation. It does not change global provider settings. The runner checks the preparation hashes and the running daemon's resolved executables before driving widgets. The registry must be empty. It then seeds 25 stopped metadata sessions through the broker and requires their unique names to appear in the selected app before the first click, preventing accidental interaction with a personal app launched from another home.

All tested mutations use Native SDK widget actions. Broker calls seed the fixture and independently read back results. The test covers:

- Exact backend names across two pages, with previous/next disabled states.
- Search and selection, including disabled resume while Grok owns a stopped session.
- New-session validation and creation with an empty first-task field. The app's normal initial task starts the fake CLI, whose response must appear in the terminal.
- Rename, normal CLI close, archive and restore with identity preserved.
- Final state: 26 stopped sessions, one fake run and no runs for the 25 seeded sessions.

The runner leaves six screenshots, semantic snapshots and `report.json` in `HOME/desktop-smoke`, with private file permissions. It preserves failure evidence and does not delete state or kill the application. A failed run requires investigation and a fresh home for a new attempt. Passing this smoke is evidence of the desktop UI path with a fake provider; it is not evidence of real CLI authorization, model output, or Grok chat delivery.
