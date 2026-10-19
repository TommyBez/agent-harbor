# Releasing

Releases are built by the [Release workflow](../.github/workflows/release.yml) on a GitHub-hosted Apple silicon runner (`macos-14`).

## Automatic releases

A pull request merged into `main` produces a release **when the shipped application changed since the last release**; nothing has to be tagged by hand.

1. The workflow finds the merged pull request for the pushed commit. Direct pushes to `main` that do not come from a pull request are not released.
2. It compares the merged commit with the newest `vX.Y.Z` tag (`scripts/release-scope.mjs`). Only files that end up in the DMG or change how it is built count: `app/` (except `app/README.md` and the native tests in `app/src/tests.zig`), `bin/`, `broker/`, `scripts/dmg.mjs`, `scripts/gui.mjs`, `scripts/native.mjs`, `scripts/package.mjs`, `package.json`, `pnpm-lock.yaml` and `LICENSE`. Changes to docs, tests, skills, contributor files or workflows alone merge without a release. Because the comparison is against the last release rather than a single pull request, application changes merged with `release:skip` are picked up by the next release.
3. Labels on the pull request adjust this: **release:major** and **release:minor** choose the bump (patch by default), **release:force** releases even without application changes, **release:skip** never releases.
4. The next version bumps the newest `vX.Y.Z` tag. The committed `package.json` version is the floor: the first release uses it, and raising it (together with `app/app.zon`) above the latest tag jumps straight to that version.
5. On an Apple silicon runner (`macos-14`) it stamps that version into the working copy only, runs the backend tests, native model tests and checks, builds the app **without** the Native SDK automation server (`pnpm build:release`), packages it (`pnpm package`) and creates a compressed disk image with an Applications link (`pnpm dmg`). It mounts the image and verifies the bundle signature, bundled runtime, version and the absence of automation.
6. It creates the `vX.Y.Z` tag on the merged commit and publishes `Agent-Harbor-<version>-arm64.dmg` and its `.sha256` file as a GitHub release, with install notes and generated release notes. Versions below 1.0.0 are marked as pre-releases.

The run summary of every merge states whether it released and why, and lists the application files that changed.

The version bump is never committed back to `main`, so the release bot needs no push rights and cannot trigger itself. Release runs are serialized: if several pull requests merge while one is building, GitHub keeps only the newest waiting run, and that release includes all of their changes.

A manual run (**Actions › Release › Run workflow**) performs the same build and verification and keeps the disk image as a 14-day workflow artifact without tagging or publishing anything.

## Build the disk image locally

```sh
pnpm build:release
pnpm package
pnpm dmg
```

The image and checksum are written to `dist/`. `pnpm build` (used for development and UI automation tests) includes the automation server and should not be shipped.

## Signing boundary

The bundle and its Node runtime are **ad-hoc signed**, not signed with a Developer ID and not notarized. Gatekeeper therefore blocks the first launch of a downloaded copy until the user allows it in **System Settings › Privacy & Security** or removes the quarantine attribute. Developer ID signing and notarization require an Apple Developer account, credentials stored as repository secrets and runtime entitlements for the bundled Node.js; they are not configured.
