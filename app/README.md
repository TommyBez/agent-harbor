# Native desktop application

This directory contains Agent Harbor's Native SDK 0.6.2 interface. Run development commands from the **repository root**, using the pinned SDK and repository scripts:

```sh
pnpm install
pnpm build
pnpm dev
```

`dev` launches the compiled native executable; it does not build it or provide a generic hot-reload server. Rebuild after changing the native source or markup.

```sh
pnpm test:ui
pnpm check
pnpm package
```

Run `pnpm build` before packaging. `test:ui` runs native model tests. `check` validates relevant source and markup. A passing build/model test is separate from verifying the actual window through Native SDK automation.

## Source layout

- `src/app.native`: declarative view, session list, controls, forms and terminal surface.
- `src/main.zig`: application model, messages, update logic, controller subscription and selected terminal attachment.
- `src/tests.zig`: native model tests.
- `app.zon`: application metadata and SDK configuration.
- `assets/`: application-owned visual assets.

The app renders native controls and a terminal surface. The Node controller in the repository's `broker/` directory owns durable state and process coordination; tmux owns the original agent processes. Closing the window detaches its terminal view and must not stop those processes.

The packaging script includes the Node runtime and controller resources in `Agent Harbor.app`. The source launcher supplies their locations through the repository wrapper. Do not replace either workflow with assumptions about a globally installed `native` command or a developer-specific absolute path.

Read [architecture](../docs/ARCHITECTURE.md), [UX research](../docs/UX-RESEARCH.md) and [the upstream Native SDK guidance](../docs/NATIVE-SKILLS.md) before changing behavior. See [the root README](../README.md) for prerequisites and complete setup.
