# UX research and interaction specification

Research date: 2026-10-17. Research preceded implementation of the Agent Harbor desktop interface.

## Scope and method

Eight Mobbin MCP `search_screens` searches in `deep` mode returned 24 screen previews. All 24 previews were visually inspected. Each search used the web catalog because Mobbin exposes iOS and web catalogs, not a dedicated macOS catalog. Web references inform hierarchy and interaction patterns; Agent Harbor remains a native desktop application.

The stable research intent was: “Build a desktop workspace for managing multiple persistent AI coding agent terminals and human-bot control handoffs.” The output destination was `code` throughout. No proprietary screenshots or expiring image URLs are stored in this public repository. Links below open the canonical Mobbin references.

This is a comparative design review, not usability testing with representative users. A screenshot demonstrates visible hierarchy and controls, not the behavior behind those controls. In particular, this research did not establish a reference product's durable CLI session semantics or prove a human/AI input handoff.

## Evidence inventory

### 1. Workspace navigation and task hierarchy

Query: “Project workspace with a left sidebar of projects and tasks, and a central list of active work with status indicators.”

- [ClickUp — project task list](https://mobbin.com/screens/caff93fc-a78d-413a-bd6b-01c82845b482): the image shows a persistent workspace sidebar, grouped task statuses, a central list and an open project menu. Status groups are easy to scan, but multiple navigation rails and dense menus would consume excessive space next to a terminal.
- [Wrike — dashboard](https://mobbin.com/screens/d750f820-568f-4a4f-8540-1692449871de): a dark sidebar contains spaces and projects; the main area has separate task widgets and a review-status summary. Useful for broad monitoring, but a card dashboard is a poor default for continuous terminal work.
- [Productboard — task detail](https://mobbin.com/screens/6ca218fe-d545-49fd-abff-a0032ab03d2a): the task list remains visible while a large right detail pane shows the selected task. The selected context survives inspection. This supports a persistent session list alongside a selected workspace.

**Decision:** use one session sidebar, not separate navigation rails or a dashboard of cards. Keep session identity visible while inspecting its terminal.

### 2. Long-running work and status

Query: “List of background jobs or agent runs with running, completed, failed status, timestamps, and a detail panel for the selected run.”

- [Browserbase — agent run trace](https://mobbin.com/screens/6fd2d728-88b8-4276-a09c-9670afb19bb7): a selected run exposes a timeline, typed execution steps and a result. The detail is valuable for diagnosis, but too dense to be the normal working view.
- [OpenAI Platform — batch details](https://mobbin.com/screens/2405cd1e-66fd-4cf2-ae4e-f468328cad91): a compact list on the left selects a detailed status view on the right. Status, creation time, request counts and timeline are readable independently of the destructive cancel action at the bottom.
- [Databricks — job run](https://mobbin.com/screens/73a15e11-aec8-40ea-ab1b-d9946fbb99e7): the task table uses icon plus text for status; a right inspector holds IDs, times and duration. Technical metadata is available without occupying the primary table.

**Decision:** preserve the terminal as primary content. Place session title, provider, project and meaningful state in its header. Put native IDs, process information and recent lifecycle events in an optional detail view rather than the default interface. Use text plus an icon for every state.

### 3. Starting an agent

Query: “Create a new AI agent task with a project or repository selector, model choice, prompt text box, and a start button.”

- [Clay — build an agent](https://mobbin.com/screens/449e224a-1d9a-443b-8789-89515a207d41): the large task input is primary, with a model selector below and a clear build action. Model descriptions are secondary in a menu. The empty agent list remains below.
- [Relevance AI — starting point](https://mobbin.com/screens/2d07fe32-68f8-4184-b164-3f6339e7cafd): a centered creation dialog groups entry options, a multiline instruction and the start action. The decorative banner is not necessary for a daily productivity tool.
- [Grok — voice agent setup](https://mobbin.com/screens/fb3318cc-b05f-4116-b44c-1771783649e9): a small centered form combines templates, a description and one primary generate action. This reference is the Grok voice-agent interface, not Grok Bot and not evidence of a Grok Bot integration.

**Decision:** a compact “New session” sheet with provider, project folder, session name and optional initial task. Default to the last selected project only when visibly shown. Provider is a meaningful first-class choice; advanced CLI options are secondary. Show the resulting session immediately while startup proceeds.

### 4. Fast navigation

Query: “Command palette overlay for quickly finding and switching between projects and recent tasks, with keyboard shortcuts and a search input.”

- [Vapi — command palette](https://mobbin.com/screens/593d7acd-2e16-4365-bcd6-02ce52f48f3b): a focused search overlay separates actions, recent pages and all pages; keyboard hints sit at the bottom.
- [Magnific — navigation palette](https://mobbin.com/screens/e22e26e2-f813-4f1e-beda-43c9ecf26419): recents and quick actions share a compact list, with a visible selected row and shortcuts aligned to the right.
- [Supabase — command menu](https://mobbin.com/screens/9b4725f5-e038-4fc7-98ad-64a59f74b4d7): shortcuts, queries and actions are grouped under one input. The surrounding project page stays recognizable.

**Decision:** immediate session search is essential for N sessions. Search names, project paths and providers. A command palette is useful as a later acceleration layer; do not make it the only route to any operation. Reserve application shortcuts carefully so terminal shortcuts reach the original CLI.

### 5. Attention and activity

Query: “Inbox of actionable notifications grouped by unread activity, with the selected notification details and actions to resolve or mark it done.”

- [Asana — inbox](https://mobbin.com/screens/c7bcaf87-9928-407c-823a-bc1491fe566d): activity is grouped by time with unread dots and task context. It is easy to scan but mixes actionable and informational content.
- [Workable — inbox](https://mobbin.com/screens/eb832076-04cc-49d7-8d03-df35a12f25e0): compact rows show sender, context and a short summary; a selected row expands in place. The left filters have counts.
- [ClickUp — inbox filters](https://mobbin.com/screens/f1374e47-4168-46b0-baab-445916244ac6): Primary, Other, Later and Cleared are visible categories; a row offers an explicit Clear action.

**Decision:** use an “Attention” filter for sessions that need a real action, such as a CLI permission prompt, launch failure or disconnected process. Do not equate unread output with failure. Completion can be a quiet activity event. Attention state must be based on explicit observable evidence, not a guessed terminal phrase.

### 6. Exploratory human/AI handoff search

Query: “Customer support conversation assigned to an AI agent with a human takeover action, conversation history, and an assignment or ownership indicator.”

- [WhatsApp — Meta AI conversation](https://mobbin.com/screens/85e15d0a-cd09-435e-b0f9-a8910479acbe): a conversation list and visible assistant identity, but no human takeover control is shown.
- [Zapier — assistant activity](https://mobbin.com/screens/cb65c41e-e7b6-4bd9-af40-cd92d768e90d): a chat/activity switch and expandable action cards expose agent work; the image does not show exclusive ownership or takeover.
- [Fiverr — Neo conversation](https://mobbin.com/screens/d72f52d6-ad44-4ec7-9b00-d933ba7ad747): assistant and human conversations coexist in navigation; no transfer-of-control mechanism is visible.

**Finding:** this search did not provide a direct handoff reference. Treating these screens as proof of takeover would be misleading. A more specific assignment search followed.

### 7. Visible ownership and assignment

Query: “Intercom inbox conversation with assignee controls and conversation status.”

- [Intercom — assigned conversation](https://mobbin.com/screens/489fd69a-c515-421a-85ea-8658ababea21): the conversation list remains beside the selected conversation; the detail pane explicitly shows Assignee and Team inbox. Navigation distinguishes personal, unassigned and AI-agent conversations.
- [Intercom — conversation and profile menu](https://mobbin.com/screens/b8c6081b-760d-417f-947c-44abe25d0a6c): assignment remains visible in the right detail pane while an account menu is open. Identity and presence are separate from the conversation content.
- [Intercom — searched conversations](https://mobbin.com/screens/4bfa129c-0cf2-4185-bc90-1f1b4f583cb0): search results coexist with the selected conversation and assignment details. Highlighted matched text helps recognize the right context.

**Decision:** distinguish “who may type” from “what the process is doing.” Agent Harbor needs an explicit owner label and a direct “Take control” / “Return to bot” operation. Ownership must not be inferred from the last message sender or focus. This is a product-specific design decision inspired by assignment visibility, not an observed Intercom terminal handoff.

### 8. Coding workspace density

Query: “Developer coding workspace with project files sidebar, editor tabs, and an integrated terminal panel.”

- [Google AI Studio — code workspace](https://mobbin.com/screens/c5a3a587-d9fc-4bf0-933a-ad30ef82a758): conversation, file navigation and tabbed editor share a horizontal layout. Error and recovery messages stay in conversation context. The preview shows an editor, not an integrated terminal.
- [v0 — code view](https://mobbin.com/screens/cd2fab36-5aa9-4ea9-97cb-e4fc0d7bb08b): a narrow chat pane and file tree leave most width for the selected editor tab. The preview does not demonstrate terminal behavior.
- [Lovable — code view](https://mobbin.com/screens/68a5d862-9ebb-4fd0-bc9c-f4c8c1486cbd): chat, files/search and the code area use stable vertical divisions; the code area is visibly loading. The visible state suggests a local loading indicator is preferable to replacing the entire workspace.

**Decision:** give the selected terminal the largest area. Do not replicate an editor, file tree or a second chat surface in the first release. Preserve a stable layout while attaching or reconnecting a terminal.

## Proposed desktop interface

### Information hierarchy

1. Unified window header: the content extends under a tall macOS titlebar. The sidebar half holds the traffic lights, product name and New session; the workspace half is the session header. It is also the window drag region.
2. Session sidebar: search, a Sessions/Archive scope and collapsible sections in triage order — Needs attention, Active, Closed. Each compact row shows a status glyph, name, relative last activity, provider, project basename and a Grok marker when the bot owns it. The selected row has a visible background. A right-click menu offers rename, control, terminal, copy, close/resume and archive/restore for that row. The footer shows controller connection, transient confirmations and pagination only when there is more than one page.
3. Main workspace: session name, provider and home-relative path, a state chip, a two-segment **You / Grok** control, rename, external terminal, details and the state-dependent lifecycle action, then the original terminal.
4. Contextual banners between header and terminal: needs attention (with the specific reason, such as a permission request), Grok has control (observation with a single Take control action), and a pending human request. Failures stay in a dismissible workspace banner; routine confirmations fade from the sidebar footer after five seconds.
5. Secondary details: a closable right inspector with native conversation ID, session ID, agent, working directory, controller, process, run, creation and last update, the last attention code and a terminal reconnect action. These are diagnostic details, not required vocabulary for normal use.

The sidebar should remain usable with 0, 1, 10 and 100 sessions. Do not give each session a fixed application tab or instantiate a terminal renderer for every historical session. Keep the selected session stable when rows update or the scope changes. A session moves between sections only on meaningful lifecycle evidence (needs attention, process alive, closed), never on every working/ready turn, so rows do not jump while agents work. Startup selects the remembered session unless it is archived; otherwise it prefers a session that needs attention, then an active one.

### Visual direction

Use a calm desktop shell with neutral surfaces, one restrained green identity hue, subtle separators and one strong selection treatment. Light and dark palettes follow the system appearance; high contrast uses the toolkit's own register. The terminal inherits the shell background and text colors. Terminal colors should preserve the agent CLI's own output and legibility. Use native typography and controls where possible. Avoid oversized cards, decorative illustrations, gradients and marketing copy. Use short, literal labels. Minimum practical window size should leave a useful terminal width; collapse secondary details before the terminal becomes narrow.

### State model visible to users

| Dimension | Examples | Meaning |
|---|---|---|
| Session lifecycle | Starting, Open, Closed, Reconnecting, Failed | Whether a CLI process exists and can be reached |
| Agent activity | Working, Ready, Needs attention, Unknown | What current evidence says about the agent turn |
| Control | You, Grok Bot | Who can submit input through Harbor |
| Persistence | Saved session available, Native identity pending | Whether an exact conversation can be resumed |

Do not collapse these dimensions into one green dot. “Closed” is not “Failed.” “Ready” is not a guarantee that arbitrary terminal input is safe. A native identity may arrive asynchronously after startup. A status without fresh evidence should become unknown or disconnected rather than falsely remain successful.

## Core journeys and acceptance criteria

### Create and start

Open New session, select Claude Code or Codex, choose a local project, optionally name the session and supply its first task. The form defaults to the selected session's provider and project, offers up to four recent projects as one-click chips, names the session after the project folder when the name is empty, and starts with Cmd+Enter from the task field. Validate a real directory and an available CLI before claiming success. Create a durable session record, show it in the sidebar, then attach its terminal. Display normal CLI onboarding and permission prompts intact. Never promise that a new, untrusted project starts without human approval, unless the human pre-authorized its parent folder. Show the CLI's trust question as a Harbor banner the human can answer without taking control.

Accept when multiple independent sessions of the same provider can be created and selected, their terminal output remains distinct, and creation failures identify the affected session and a recoverable action.

### Observe bot work

Selecting a bot-controlled session shows its live terminal with “Controlled by Grok Bot.” Observation must not transfer ownership or send keys. The user can inspect output without perturbing the bot. The UI must not silently accept keystrokes into a bot-controlled terminal.

### Take control and return it

“Take control” atomically transfers the input owner. Show the result before enabling terminal input. The bot receives a structured ownership conflict if it tries to send after the transfer. A request already delivered before transfer is not secretly duplicated or cancelled. “Return to bot” transfers the owner explicitly and records an activity event. If the operation fails, keep the prior owner and explain the failure.

Accept when alternating human/bot control preserves one conversation, attempted wrong-owner input is rejected, and a bot retry cannot duplicate an already delivered prompt.

### Close and resume

Distinguish closing the window from stopping a CLI. Closing the desktop window leaves sessions running. An explicit Stop action requests a normal CLI exit and retains the conversation. A closed session has a clear Resume action. Resume targets its saved native identity, not the provider's most recent conversation. If no native identity was captured, explain that recovery is unavailable rather than creating an unrelated session silently.

Accept when both CLI processes can exit, a window can close and reopen, and Resume reconnects the exact conversation with new process IDs and recovered context. A timeout must surface truthfully; do not report a stopped process that remains alive.

### Find and triage

Search narrows by session title, provider, project and Grok ownership, and temporarily ignores collapsed sections so a match is never hidden. Sections expose attention, active and closed sessions; the archive is a separate scope. A no-results state keeps the search field visible and offers clearing the search. A blank registry shows a welcome workspace with one-click Claude Code and Codex starts; a just-created session shows a local spinner until the controller lists it. A missing CLI or tmux dependency offers a precise diagnosis; do not replace the entire interface with an opaque generic error.

## Accessibility and keyboard behavior

- Provide accessible names for icon controls, labeled text fields and text descriptions of status; never rely on color alone.
- Support predictable Tab order, visible keyboard focus, Escape to dismiss sheets and focus restoration to the originating control.
- Keep terminal key handling separate from app shortcuts. Preserve the CLI's interactive keys, paste and interrupt behavior. Do not globally intercept ordinary terminal shortcuts. App shortcuts always carry Command: Cmd+N new session, Cmd+F search, Cmd+I details, Cmd+1–9 open the Nth row on the page, Cmd+Option+Up/Down previous/next session. Selecting a session moves keyboard focus to its terminal.
- Do not steal focus when background sessions update. Announce important state changes sparingly rather than reading every output chunk.
- Keep text scalable and contrast sufficient in both terminal and shell. Loading and error states must be perceivable without animation.
- Long names and project paths must truncate predictably with full values accessible in details; session identity must remain unambiguous.

## Verification plan and boundaries

Test model transitions and ownership rules below the UI. Then test the real native application: create two sessions of one provider, search/select them, create the other provider, inspect output, transfer control, stop/resume, close/reopen the application, and observe a dependency or launch failure. Use native accessibility/automation snapshots plus screenshots to inspect actual rendering. Stress the list with many synthetic records independently of expensive authenticated agent runs.

A native build, source-level layout review or a screenshot alone does not establish the complete user journey. Full interactive CLI feature parity, terminal Unicode/selection behavior, recovery after machine reboot and stability under sustained parallel workloads need explicit validation. Record each verified boundary and unresolved limitation in the release evidence rather than treating the UI design as proof.
