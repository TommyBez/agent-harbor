# Releasing

Releases are built by the [Release workflow](../.github/workflows/release.yml) on a GitHub-hosted Apple silicon runner (`macos-14`).

## Cut a release

1. Set the same version in `package.json` (`version`) and `app/app.zon` (`.version`).
2. Commit the change on `main` and push it.
3. Tag that commit and push the tag:

   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```

The workflow refuses a tag that does not match both version fields. It runs the backend tests, native model tests and checks, builds the app **without** the Native SDK automation server (`pnpm build:release`), packages it (`pnpm package`) and creates a compressed disk image with an Applications link (`pnpm dmg`). It then mounts the image and verifies the bundle signature, bundled runtime, version and the absence of automation before publishing `Agent-Harbor-<version>-arm64.dmg` and its `.sha256` file as a GitHub release. Versions below 1.0.0 and versions with a suffix such as `-rc.1` are published as pre-releases.

A manual run (**Actions › Release › Run workflow**) performs the same build and verification and keeps the disk image as a 14-day workflow artifact without publishing anything.

## Build the disk image locally

```sh
pnpm build:release
pnpm package
pnpm dmg
```

The image and checksum are written to `dist/`. `pnpm build` (used for development and UI automation tests) includes the automation server and should not be shipped.

## Signing boundary

The bundle and its Node runtime are **ad-hoc signed**, not signed with a Developer ID and not notarized. Gatekeeper therefore blocks the first launch of a downloaded copy until the user allows it in **System Settings › Privacy & Security** or removes the quarantine attribute. Developer ID signing and notarization require an Apple Developer account, credentials stored as repository secrets and runtime entitlements for the bundled Node.js; they are not configured.
