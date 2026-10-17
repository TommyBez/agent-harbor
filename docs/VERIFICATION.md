# Verification record

Date: **2026-10-17**. This is the first-release verification checkpoint. It separates real provider behavior, automated component tests, native UI observations and unverified capabilities. The real Grok Bot response, packaged-app observations and isolated desktop smoke test below have been confirmed. The source is published at [TommyBez/agent-harbor](https://github.com/TommyBez/agent-harbor); repository visibility and the uploaded source commit were read back after publication. External Terminal interaction remains a separate boundary.

## Four real interactive CLI sessions: passed

The live scenario used the installed original **Codex 0.162.1** and **Claude Code 2.1.302** CLIs: two independent conversations from each provider. Normal trust and permission prompts remained effective.

The [sanitized machine-readable summary](evidence/live-2026-10-17.json) records the completed scenario. Private transcripts, prompts, markers, project paths, native IDs, request IDs, process IDs and the experiment UUID are deliberately excluded from that public artifact.

| Session | Real fixture tests | Human ownership enforced | Actual exit | Exact conversation resumed | New process | Marker recalled without tools |
|---|---|---|---|---|---|---|
| Codex 1 | 2/2 passed | Passed | Passed | Passed | Passed | Passed |
| Codex 2 | 2/2 passed | Passed | Passed | Passed | Passed | Passed |
| Claude 1 | 2/2 passed | Passed | Passed | Passed | Passed | Passed |
| Claude 2 | 2/2 passed | Passed | Passed | Passed | Passed | Passed |

What the runner checked:

- Each conversation analyzed the local invoice fixture and ran its two Node tests. The runner required a matching native tool event with successful test output; an assistant's assertion alone was insufficient.
- Each conversation received a distinct marker. Session and native-turn correlation kept their answers separate.
- While a session belonged to the human, a Grok-actor send was rejected. The runner then returned control through the controller.
- All four original processes exited. At one recorded checkpoint all four old PIDs were absent together, rather than merely detached from a terminal.
- Resume kept each original native conversation ID and produced a different process. The follow-up prompt contained neither the expected marker nor the expected test answer.
- All four resumed conversations recalled their marker and the test result. No tool invocation was observed in those recall turns.
- The fixture remained unchanged.

The scenario completed at **17:00:34 UTC**. It is checkpointed so a retry continues the recorded operation rather than creating duplicate conversations. See [live-test instructions](../test/live/README.md) and [the runner](../test/live/scenario.mjs).

The local runner proves the controller and original-CLI lifecycle. The real-bot presentation was separately confirmed: Grok Bot's **Codex Lab** conversation displayed its final successful result for all four sessions at **19:01:49 Europe/Rome**. This observation is separate from the machine-readable runner summary.

## Automated checks at this checkpoint

The final local checks recorded **30/30 backend tests** with zero skips and **15/15 native model tests** passing. Source/markup checks, the final rebuild containing the parser fix and packaging checks also passed. These are local results. [GitHub Actions](https://github.com/TommyBez/agent-harbor/actions/workflows/ci.yml) separately runs the backend on Linux and macOS, plus native UI tests, checks, build and packaging on macOS; consult the run for the exact commit's remote result.

Backend coverage includes request identity, event attribution, control boundaries, startup-argument validation, persistence and fake-process lifecycle cases. Native model tests exercise the application state and list behavior; they do not substitute for operating the actual window.

### Metadata scale measurement

The local compact-list benchmark with **1,000 stored synthetic session records** measured approximately **18–19 ms p95** at this checkpoint. It started **zero AI agent processes**. The number describes metadata enumeration in the test harness, not 1,000 concurrently running agents, terminal redraw latency or a cross-machine performance guarantee.

The watch test also exercises a large stored registry and suppresses unchanged snapshots. See [the scale tests](../test/backend/scale.test.mjs) for fixture construction and measurement boundaries. The GUI renders a page of 20 rows and attaches the selected terminal; the overall process workload still depends on the actual number of active agents.

## Native UI and package evidence

| Path | Current evidence | Remaining boundary |
|---|---|---|
| Native window displays real CLI | Actual provider terminals rendered; 12 real session switches preserved usable rendering and input | Broader terminal feature matrix remains unverified |
| Window close/reopen | All four CLI PIDs survived GUI closure/reopen; the final build connected to those existing processes | Machine reboot and power-loss recovery remain unverified |
| Sidebar filters/search/pagination | Isolated real-UI smoke passed: two pages expose 25 seeded names, search selects the exact session, archive/restore preserve identity and actions | Other edge cases remain outside this eight-check scenario |
| New-session form | Actual UI validation and empty-prompt creation passed with a fake provider; its response rendered and rename persisted | This form test does not launch or certify a real AI provider |
| Human/bot control UI | Human input through the UI and the UI return-to-Grok action passed on Claude 2 and Codex 2; Grok received both follow-up answers with unchanged native IDs and PIDs | Exceptional handoff/crash cases remain outside the observed sequence |
| External Terminal fallback | UI button opened a second tmux client attached to the existing Codex 2 session, while its original agent process remained the same | External typing, menus, clipboard/IME and the full return-to-bot journey unverified |
| Packaged application launch | Package revision 3 launched from Finder without custom environment variables; isolated state/controller UI smoke also passed | Not a clean-machine installer or notarization test |
| Real Grok Bot chat | Final successful result for all four sessions visible in the real Codex Lab bot conversation at 19:01:49 Europe/Rome | This evidence covers the tested local bot and scenario |
| Final bundled controller adoption | The final app launched normally with four active sessions; a replacement daemon using bundled Node/controller resources adopted all four existing CLI processes without changing their PIDs; RPC readback confirmed all four alive and ready | This is controlled daemon replacement, not power-loss or every crash-boundary recovery |

The human-input test used a multiline paste containing accented text and an emoji, `caffè 🚢`, in both selected providers. Each returned the expected `HUMAN_UI caffè 🚢` marker and the remembered `TESTS 2/2` result. Native conversation IDs and process IDs stayed unchanged. This demonstrates those specific paste/content cases and continued conversation identity; it does not certify arbitrary Unicode cursor behavior, every input method or image clipboard support.

The user-facing **Passa a Grok** action then returned both sessions to the bot. Grok submitted follow-ups using stable request IDs and the `terminal-paste` transport. The prompts did not include the expected marker. At **19:10:21 Europe/Rome**, the real Codex Lab bot conversation displayed both replies containing the human-entered marker and `TESTS 2/2`. Both native conversation IDs and CLI PIDs remained unchanged. This completes the observed human → native UI → Grok → same-conversation response path for one session of each provider.

For the external Terminal action, controller/tmux inspection confirmed the additional attachment to the same existing session and agent process. The UI automation tool did not permit control of Terminal.app, so this check stops at verified attachment. No external keystroke, menu or clipboard success is claimed.

The real-provider GUI observations above are evidence from the implementation session. The separately published screenshot below comes from the isolated fake-provider UI test, not from a real AI conversation. There is no claim of notarization or a signed public installer.

## Isolated desktop UI smoke: 8 checks passed

The packaged app was exercised in a dedicated, isolated state directory. The scenario began with 25 stopped synthetic session records, then created one additional session through the actual native UI. It launched **exactly one fake interactive provider and zero real AI providers**. All 26 sessions were stopped at the end; none of the seeded records unexpectedly started.

The [sanitized smoke report](evidence/desktop-smoke-2026-10-17.json) records eight passed checks:

1. The running UI connected to the dedicated registry.
2. Both pages exposed all 25 seeded names and the correct disabled navigation controls.
3. Search selected the exact Grok-owned session and kept its unauthorized resume action disabled.
4. Form validation and empty-prompt creation launched the fake provider and displayed its response.
5. Renaming through the UI persisted on the same session identity.
6. Closing through the UI exited the fake CLI normally while preserving its conversation.
7. Archiving and restoring preserved identity and available actions.
8. Final inventory confirmed 26 stopped sessions, one fake launch and no seeded-session launches.

The smoke completed at **17:08:16 UTC**. The runner recorded six screenshots and accessibility snapshots and parsed the UI state for its assertions. The report was reviewed; only screenshot 04 was visually inspected. The report retains the local evidence filenames, and only that selected screenshot is redistributed here. Private session identifiers and process identifiers were removed from the published report. A readback also confirmed the UI request directory had mode `0700` and its request JSON had mode `0600`.

![Packaged Agent Harbor during its isolated fake-provider UI smoke test](images/desktop-smoke.png)

*Actual application screenshot from the isolated UI test. The terminal shows a fake provider; it is not real Codex or Claude output. The image is copied unchanged.*

See [the desktop smoke runner](../test/live/desktop-smoke.mjs) for its isolation and zero-real-provider checks. This test covers UI behavior and local process coordination, complementing the separate four-real-provider scenario above.

## Hook configuration compatibility audit

Codex's ordinary effective configuration and its hook registry are distinct views. An isolated **Codex 0.162.1** app-server probe requested only initialization, `config/read` and `hooks/list`; it did not create a conversation or invoke a model. The fixture declared a user hook file, a user inline hook, a project inline hook and an invocation `-c` hook for the same event.

`hooks/list` retained all four definitions with their respective sources. They remained untrusted: no hook was executed or automatically approved. `config/read` showed only the higher-priority invocation array, which would have been misleading if used alone to infer hook execution. The result agrees with [Codex's documented aggregation across hook sources](https://learn.chatgpt.com/docs/hooks?surface=cli#where-codex-looks-for-hooks).

For Claude Code, current primary documentation establishes that hook entries combine across settings scopes and that `--settings` supplies an invocation-only settings level. See [Claude settings precedence](https://code.claude.com/docs/en/settings) and [Claude hooks](https://code.claude.com/docs/en/hooks). This is **documentation-backed compatibility**, not a new local Claude hook-execution test.

This audit does not certify every user hook, managed policy or event. Representative existing hook execution alongside Harbor's observer remains a separate live validation item. Manually copying all user hooks into the invocation override would risk duplicate execution and is not required by this evidence.

## Explicitly unverified

- Full machine reboot, power loss and every crash timing boundary.
- Every terminal feature beyond the specific multiline/accent/emoji cases above, including Unicode cursor edge cases, IME, image clipboard, drag/drop and external editor integration.
- Every CLI startup flag, model, plugin, skill, MCP integration or provider update.
- Real provider worktree onboarding and all advanced option combinations.
- Sustained performance with large numbers of simultaneously active AI agents.
- External Terminal interaction beyond attachment and UI cases outside the recorded scenarios.

The [capability matrix](CLI-PARITY.md) and [architecture validation inventory](ARCHITECTURE.md#validation-matrix) retain these distinctions. A passing ordinary lifecycle does not certify universal CLI parity.
