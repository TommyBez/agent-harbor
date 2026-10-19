const std = @import("std");
const runner = @import("runner");
const sdk = @import("native_sdk");
const canvas = sdk.canvas;
pub const panic = std.debug.FullPanic(sdk.debug.capturePanic);
const alloc = std.heap.page_allocator;
var node_path: []const u8 = "node";
var cli_path: []const u8 = "bin/harbor.mjs";
var gui_path: []const u8 = "scripts/gui.mjs";
var preferences_path: []const u8 = "";
var request_directory: []const u8 = "ui-requests";
var home_directory: []const u8 = "";
var intent_entropy: [32]u8 = @splat(0);
var intent_sequence: u64 = 0;
const label = "main-canvas";
const views = [_]sdk.ShellView{.{ .label = label, .kind = .gpu_surface, .fill = true, .role = "Session workspace", .accessibility_label = "Agent Harbor", .gpu_backend = .metal, .gpu_pixel_format = .bgra8_unorm, .gpu_present_mode = .timer, .gpu_alpha_mode = .@"opaque", .gpu_color_space = .srgb, .gpu_vsync = true }};
const windows = [_]sdk.ShellWindow{.{ .label = "main", .title = "Agent Harbor", .width = 1380, .height = 900, .min_width = 980, .min_height = 620, .restore_state = true, .titlebar = .hidden_inset_tall, .views = &views }};
const scene: sdk.ShellConfig = .{ .windows = &windows };
const permissions = [_][]const u8{ sdk.security.permission_command, sdk.security.permission_view };
// App shortcuts always carry a modifier, so ordinary terminal keys still reach the CLI.
const shortcuts = [_]sdk.Shortcut{
    .{ .id = "session.new", .key = "n", .modifiers = .{ .primary = true } },
    .{ .id = "session.search", .key = "f", .modifiers = .{ .primary = true } },
    .{ .id = "session.details", .key = "i", .modifiers = .{ .primary = true } },
    .{ .id = "session.next", .key = "arrowdown", .modifiers = .{ .primary = true, .option = true } },
    .{ .id = "session.previous", .key = "arrowup", .modifiers = .{ .primary = true, .option = true } },
    .{ .id = "session.1", .key = "1", .modifiers = .{ .primary = true } },
    .{ .id = "session.2", .key = "2", .modifiers = .{ .primary = true } },
    .{ .id = "session.3", .key = "3", .modifiers = .{ .primary = true } },
    .{ .id = "session.4", .key = "4", .modifiers = .{ .primary = true } },
    .{ .id = "session.5", .key = "5", .modifiers = .{ .primary = true } },
    .{ .id = "session.6", .key = "6", .modifiers = .{ .primary = true } },
    .{ .id = "session.7", .key = "7", .modifiers = .{ .primary = true } },
    .{ .id = "session.8", .key = "8", .modifiers = .{ .primary = true } },
    .{ .id = "session.9", .key = "9", .modifiers = .{ .primary = true } },
};
pub const page_size = 20;

pub const Filter = enum { all, archived };
/// Sidebar sections, in triage order. A session changes section only on a
/// meaningful lifecycle event, never on every turn.
pub const Group = enum { attention, active, closed, archived };
pub const NoticeKind = enum { info, success, failure };
pub const Session = struct {
    id: []const u8,
    title: []const u8 = "Sessione",
    provider: []const u8 = "codex",
    project: []const u8 = "",
    workingDirectory: ?[]const u8 = null,
    owner: []const u8 = "human",
    alive: bool = false,
    status: []const u8 = "stopped",
    pending: bool = false,
    closing: bool = false,
    @"error": ?[]const u8 = null,
    nativeSessionId: ?[]const u8 = null,
    runId: ?[]const u8 = null,
    pid: ?i64 = null,
    createdAt: ?[]const u8 = null,
    updatedAt: ?[]const u8 = null,
    pub fn providerName(s: *const Session) []const u8 { return if (eq(s.provider, "claude")) "Claude Code" else "Codex"; }
    pub fn isArchived(s: *const Session) bool { return eq(s.status, "archived"); }
    pub fn failed(s: *const Session) bool { return eq(s.status, "error"); }
    pub fn needsAttention(s: *const Session) bool { return s.failed() or (s.alive and eq(s.status, "attention")); }
    pub fn starting(s: *const Session) bool { return s.alive and eq(s.status, "starting"); }
    pub fn working(s: *const Session) bool { return s.alive and !s.needsAttention() and (s.pending or eq(s.status, "running") or eq(s.status, "starting")); }
    pub fn ready(s: *const Session) bool { return s.alive and !s.needsAttention() and !s.working(); }
    pub fn group(s: *const Session) Group {
        if (s.isArchived()) return .archived;
        if (s.needsAttention()) return .attention;
        return if (s.alive) .active else .closed;
    }
    pub fn statusName(s: *const Session) []const u8 {
        if (s.isArchived()) return "Archiviata";
        if (s.failed()) return "Errore";
        if (!s.alive) return "Chiusa";
        if (s.needsAttention()) return "Da controllare";
        if (s.closing) return "Chiusura";
        if (s.starting()) return "Avvio";
        return if (s.working()) "Al lavoro" else "Pronta";
    }
    pub fn ownerName(s: *const Session) []const u8 { return if (eq(s.owner, "human")) "Tu" else "Grok"; }
    pub fn path(s: *const Session) []const u8 { return s.workingDirectory orelse s.project; }
};
const Snapshot = struct { sessions: []const Session };
pub const max_snapshot_line_bytes = 256 * 1024;
pub const max_snapshot_bytes = 16 * 1024 * 1024;
const SnapshotHeader = struct { type: []const u8, snapshotId: []const u8, count: ?usize = null };
const PendingSnapshot = struct {
    arena: *std.heap.ArenaAllocator,
    id: []const u8,
    expected_count: usize,
    bytes: usize,
    sessions: std.ArrayList(Session) = .empty,

    fn init(id: []const u8, count: usize, bytes: usize) !PendingSnapshot {
        const arena = try alloc.create(std.heap.ArenaAllocator);
        arena.* = std.heap.ArenaAllocator.init(alloc);
        errdefer { arena.deinit(); alloc.destroy(arena); }
        return .{ .arena = arena, .id = try arena.allocator().dupe(u8, id), .expected_count = count, .bytes = bytes };
    }
    fn deinit(p: *PendingSnapshot) void { p.arena.deinit(); alloc.destroy(p.arena); }
};
/// One sidebar line: either a section header or a session row.
pub const Row = struct {
    id: []const u8,
    header: bool = false,
    group: Group = .active,
    heading: []const u8 = "",
    collapsed: bool = false,
    title: []const u8 = "",
    meta: []const u8 = "",
    status: []const u8 = "",
    when: []const u8 = "",
    selected: bool = false,
    failed: bool = false,
    attention: bool = false,
    working: bool = false,
    ready: bool = false,
    archived: bool = false,
    alive: bool = false,
    grok: bool = false,
};
pub const ProjectChip = struct { path: []const u8, name: []const u8 };
pub const Msg = union(enum) {
    select: []const u8, select_index: usize, select_next, select_previous,
    filter_all, filter_archived, toggle_group: Group, clear_search, focus_search,
    search_edit: canvas.TextInputEvent, new_session, new_claude, new_codex, cancel_form, create_session,
    title_edit: canvas.TextInputEvent, project_edit: canvas.TextInputEvent, prompt_edit: canvas.TextInputEvent,
    toggle_advanced, cli_args_edit: canvas.TextInputEvent, pick_project: []const u8,
    choose_provider: []const u8, choose_folder, folder_done: sdk.EffectExit,
    take_control, release_control, start_session, stop_session, archive_session, restore_session,
    rename_session, rename_edit: canvas.TextInputEvent, save_name, cancel_name,
    reconnect, show_details, open_terminal, copy_id, copy_session_id, previous_page, next_page, dismiss_notice,
    row_rename: []const u8, row_take: []const u8, row_release: []const u8, row_terminal: []const u8, row_copy: []const u8,
    row_start: []const u8, row_stop: []const u8, row_archive: []const u8, row_restore: []const u8,
    status_line: sdk.EffectLine, watch_done: sdk.EffectExit, command_done: sdk.EffectExit,
    tick: sdk.EffectTimer, notice_expired: sdk.EffectTimer, terminal_event: sdk.EffectPtyEvent, terminal_state: canvas.TerminalState,
    prefs_loaded: sdk.EffectFileResult, prefs_saved: sdk.EffectFileResult, create_file_saved: sdk.EffectFileResult, copied: sdk.EffectClipboardResult,
    appearance: sdk.platform.Appearance, chrome: sdk.platform.WindowChrome,
    pub const view_unbound = .{ "select_index", "select_next", "select_previous", "focus_search", "status_line", "watch_done", "command_done", "tick", "notice_expired", "terminal_event", "folder_done", "prefs_loaded", "prefs_saved", "create_file_saved", "copied", "appearance", "chrome", "copy_session_id" };
};
pub const Model = struct {
    snapshot: ?std.json.Parsed(Snapshot) = null,
    pending_snapshot: ?PendingSnapshot = null,
    selection: canvas.TextBuffer(64) = .{},
    search_buffer: canvas.TextBuffer(256) = .{},
    title_buffer: canvas.TextBuffer(160) = .{},
    project_buffer: canvas.TextBuffer(4096) = .{},
    prompt_buffer: canvas.TextBuffer(8192) = .{},
    cli_args_buffer: canvas.TextBuffer(8192) = .{},
    rename_buffer: canvas.TextBuffer(160) = .{},
    filter: Filter = .all,
    collapsed: [4]bool = @splat(false),
    page: usize = 0,
    creating: bool = false,
    renaming: bool = false,
    form_claude: bool = false,
    advanced: bool = false,
    details: bool = false,
    busy: bool = false,
    watching: bool = false,
    connected: bool = false,
    notice_buffer: canvas.TextBuffer(1536) = .{},
    notice_kind: NoticeKind = .info,
    action: enum { other, create, start, control, external, stop, archive, restore, rename } = .other,
    attached_id: canvas.TextBuffer(64) = .{},
    attached_run_id: canvas.TextBuffer(64) = .{},
    attached: bool = false,
    detaching: bool = false,
    attachment_human: bool = false,
    attach_wait: bool = false,
    operation_session: canvas.TextBuffer(64) = .{},
    create_id: canvas.TextBuffer(36) = .{},
    create_file_path: canvas.TextBuffer(4096) = .{},
    create_payload_hash: [32]u8 = @splat(0),
    create_intent_valid: bool = false,
    terminal_key: u64 = 20,
    cols: u16 = 0,
    rows: u16 = 0,
    scrollback: u32 = 0,
    first_output: bool = false,
    // Edge-triggered focus requests: set by one update, cleared by the next.
    focus_terminal: bool = false,
    search_focus: bool = false,
    now_s: i64 = 0,
    dark: bool = false,
    high_contrast: bool = false,
    chrome_left: f32 = 0,
    chrome_top: f32 = 0,
    chrome_center: f32 = 0,
    pub const view_unbound = .{ "snapshot", "pending_snapshot", "selection", "search_buffer", "title_buffer", "project_buffer", "prompt_buffer", "cli_args_buffer", "rename_buffer", "collapsed", "page", "watching", "notice_buffer", "notice_kind", "action", "attached_id", "attached_run_id", "attached", "detaching", "attachment_human", "terminal_key", "cols", "rows", "first_output", "attach_wait", "operation_session", "create_id", "create_file_path", "create_payload_hash", "create_intent_valid", "pending", "filteredCount", "sessions", "deinit", "now_s", "dark", "high_contrast", "chrome_left", "chrome_top", "chrome_center", "matches", "orderedIds", "preferred", "effectiveTitle", "inScope", "loading", "filter", "cannotRelease", "canStart", "activeCount", "attentionCount", "matchCount", "pageCount" };
    pub fn deinit(m: *Model) void { discardPending(m); if (m.snapshot) |p| p.deinit(); m.snapshot = null; }
    pub fn sessions(m: *const Model) []const Session { return if (m.snapshot) |p| p.value.sessions else &.{}; }
    pub fn selected(m: *const Model) ?Session { for (m.sessions()) |s| { if (eq(s.id, m.selection.text())) return s; } return null; }
    pub fn hasSelection(m: *const Model) bool { return m.selected() != null; }
    pub fn loading(m: *const Model) bool { return m.snapshot == null; }
    /// The welcome screen is only for an empty registry; a just-created session shows a spinner until listed.
    pub fn showWelcome(m: *const Model) bool { return m.snapshot != null and m.sessions().len == 0; }
    pub fn placeholderText(m: *const Model) []const u8 { return if (m.snapshot == null) m.connection() else "Apertura della sessione..."; }

    // Window chrome: the sidebar header carries the traffic lights.
    /// Header controls share the traffic lights' centerline; without lights (fullscreen) the band is 52.
    pub fn headerHeight(m: *const Model) f32 { return if (m.chrome_center > 0) @max(44, m.chrome_center * 2) else @max(52, m.chrome_top); }
    pub fn chromeLeading(m: *const Model) f32 { return if (m.chrome_left > 0) m.chrome_left else 16; }

    // Selected session.
    pub fn selectedTitle(m: *const Model) []const u8 { return if (m.selected()) |s| s.title else "Agent Harbor"; }
    pub fn selectedProvider(m: *const Model) []const u8 { return if (m.selected()) |s| s.providerName() else ""; }
    pub fn selectedProject(m: *const Model) []const u8 { return if (m.selected()) |s| s.path() else ""; }
    pub fn selectedSubtitle(m: *const Model, arena: std.mem.Allocator) []const u8 {
        const s = m.selected() orelse return "";
        return std.fmt.allocPrint(arena, "{s} · {s}", .{ s.providerName(), displayPath(arena, s.path()) }) catch "";
    }
    pub fn selectedStatus(m: *const Model) []const u8 { return if (m.selected()) |s| s.statusName() else ""; }
    pub fn selFailed(m: *const Model) bool { return if (m.selected()) |s| s.failed() else false; }
    pub fn selWorking(m: *const Model) bool { return if (m.selected()) |s| s.working() else false; }
    pub fn selReady(m: *const Model) bool { return if (m.selected()) |s| s.ready() else false; }
    pub fn nativeId(m: *const Model) []const u8 { return if (m.selected()) |s| s.nativeSessionId orelse "In attesa del primo turno" else ""; }
    pub fn hasNativeId(m: *const Model) bool { return if (m.selected()) |s| s.nativeSessionId != null else false; }
    pub fn selectedId(m: *const Model) []const u8 { return m.selection.text(); }
    pub fn runLabel(m: *const Model) []const u8 { return if (m.selected()) |s| s.runId orelse "Nessun processo avviato" else ""; }
    pub fn pidLabel(m: *const Model, arena: std.mem.Allocator) []const u8 {
        const s = m.selected() orelse return "";
        if (!s.alive) return "Nessun processo attivo";
        const pid = s.pid orelse return "In attesa";
        return std.fmt.allocPrint(arena, "PID {d}", .{pid}) catch "";
    }
    pub fn createdLabel(m: *const Model, arena: std.mem.Allocator) []const u8 { return if (m.selected()) |s| absoluteTime(arena, s.createdAt) else ""; }
    pub fn updatedLabel(m: *const Model, arena: std.mem.Allocator) []const u8 {
        const s = m.selected() orelse return "";
        const when = relativeTime(arena, m.now_s, s.updatedAt);
        if (when.len == 0) return absoluteTime(arena, s.updatedAt);
        return std.fmt.allocPrint(arena, "{s} · {s}", .{ when, absoluteTime(arena, s.updatedAt) }) catch "";
    }
    pub fn errorCode(m: *const Model) []const u8 { return if (m.selected()) |s| s.@"error" orelse "" else ""; }
    pub fn hasErrorCode(m: *const Model) bool { return m.errorCode().len > 0; }
    pub fn closedMeta(m: *const Model, arena: std.mem.Allocator) []const u8 {
        const s = m.selected() orelse return "";
        const when = relativeTime(arena, m.now_s, s.updatedAt);
        const conversation = if (s.nativeSessionId) |id| id[0..@min(8, id.len)] else "non ancora registrata";
        if (when.len == 0) return std.fmt.allocPrint(arena, "Conversazione {s}", .{conversation}) catch "";
        return std.fmt.allocPrint(arena, "Ultima attività {s} · Conversazione {s}", .{ when, conversation }) catch "";
    }
    pub fn alive(m: *const Model) bool { return if (m.selected()) |s| s.alive else false; }
    pub fn human(m: *const Model) bool { return if (m.selected()) |s| eq(s.owner, "human") else false; }
    pub fn grok(m: *const Model) bool { return m.hasSelection() and !m.human(); }
    pub fn pending(m: *const Model) bool { return if (m.selected()) |s| s.pending else false; }
    pub fn archived(m: *const Model) bool { return if (m.selected()) |s| s.isArchived() else false; }
    pub fn attention(m: *const Model) bool { return if (m.selected()) |s| s.needsAttention() else false; }
    pub fn controlLabel(m: *const Model) []const u8 { return if (m.human()) "Hai il controllo" else "Controllo a Grok"; }
    pub fn controlHint(m: *const Model) []const u8 {
        if (m.human() and m.pending()) return "Concludi la richiesta nel terminale prima di passare il controllo o chiudere la CLI.";
        return if (m.human()) "Scrivi direttamente nel terminale. Grok attende." else "Stai osservando. Prendi il controllo per intervenire.";
    }
    pub fn showControlHint(m: *const Model) bool { return m.alive() and m.human() and m.pending() and !m.attention(); }
    pub fn showGrokBanner(m: *const Model) bool { return m.alive() and m.grok() and !m.attention(); }
    pub fn attentionTitle(m: *const Model) []const u8 {
        const s = m.selected() orelse return "";
        if (s.failed()) return "La sessione ha un errore";
        const code = s.@"error" orelse return "Serve la tua attenzione";
        if (eq(code, "PERMISSION_REQUIRED")) return "Autorizzazione richiesta";
        if (eq(code, "CLI_ATTENTION_REQUIRED")) return "La CLI attende una risposta";
        if (eq(code, "HOOKS_NOT_READY")) return "Osservazione non ancora attiva";
        if (eq(code, "PROMPT_NOT_ACKNOWLEDGED")) return "Compito non ancora accettato";
        if (eq(code, "DELIVERY_UNCERTAIN") or eq(code, "DAEMON_RESTARTED_DURING_DELIVERY")) return "Consegna incerta";
        if (std.mem.startsWith(u8, code, "HOOK_")) return "Eventi della CLI incompleti";
        if (eq(code, "STOPFAILURE") or eq(code, "INTERRUPT")) return "Turno interrotto";
        return "Serve la tua attenzione";
    }
    pub fn attentionHint(m: *const Model) []const u8 {
        const code = m.errorCode();
        if (eq(code, "PERMISSION_REQUIRED")) return if (m.human()) "L'agente chiede di usare uno strumento. Rispondi nel terminale: Harbor non approva nulla al posto tuo." else "L'agente chiede di usare uno strumento. Prendi il controllo e rispondi nel terminale: Harbor non approva nulla al posto tuo.";
        if (eq(code, "HOOKS_NOT_READY")) return "La CLI non ha confermato l'osservazione di Harbor. Controlla nel terminale eventuali richieste di fiducia per il progetto.";
        if (eq(code, "PROMPT_NOT_ACKNOWLEDGED")) return "Il compito è stato inviato ma la CLI non l'ha ancora accettato. Controlla il terminale prima di riprovare.";
        if (eq(code, "DELIVERY_UNCERTAIN") or eq(code, "DAEMON_RESTARTED_DURING_DELIVERY")) return "Non è certo che il compito sia arrivato. Controlla il terminale: Harbor non lo reinvia automaticamente.";
        return if (m.human()) "Verifica la richiesta nel terminale. Nessuna autorizzazione viene confermata automaticamente." else "L'agente richiede attenzione. Prendi il controllo e verifica il terminale; nessuna autorizzazione viene confermata automaticamente.";
    }
    pub fn humanSegment(m: *const Model) []const u8 { return if (m.human()) "Hai il controllo" else "Assegna il controllo a te"; }
    pub fn grokSegment(m: *const Model) []const u8 { return if (m.human()) "Passa il controllo a Grok" else "Grok ha il controllo"; }
    pub fn showControl(m: *const Model) bool { return m.hasSelection() and !m.archived(); }
    pub fn cannotTake(m: *const Model) bool { return m.busy or !m.hasSelection(); }
    pub fn cannotRelease(m: *const Model) bool { return m.busy or m.pending() or !m.human(); }
    pub fn cannotGrokSegment(m: *const Model) bool { return m.human() and m.cannotRelease(); }
    pub fn cannotStop(m: *const Model) bool { return m.busy or m.pending() or !m.alive() or !m.human(); }
    pub fn canStart(m: *const Model) bool { return !m.alive() and !m.archived(); }
    pub fn cannotStart(m: *const Model) bool { return m.busy or !m.human(); }
    pub fn cannotSaveName(m: *const Model) bool { return m.busy or m.rename_buffer.isEmpty() or m.rename_buffer.truncated; }
    pub fn detailsVisible(m: *const Model) bool { return m.details and m.hasSelection() and !m.creating; }

    // Notices: failures stay in the workspace until dismissed; the rest are quiet and transient.
    pub fn notice(m: *const Model) []const u8 { return m.notice_buffer.text(); }
    pub fn showFailure(m: *const Model) bool { return m.notice_kind == .failure and !m.notice_buffer.isEmpty(); }
    pub fn showNotice(m: *const Model) bool { return m.notice_kind != .failure and !m.notice_buffer.isEmpty(); }
    pub fn noticeSuccess(m: *const Model) bool { return m.notice_kind == .success; }
    pub fn connection(m: *const Model) []const u8 { return if (m.connected) "Gestore connesso" else "Connessione al gestore..."; }

    // Sidebar list.
    pub fn searchText(m: *const Model) []const u8 { return m.search_buffer.text(); }
    pub fn searching(m: *const Model) bool { return std.mem.trim(u8, m.search_buffer.text(), " \t").len > 0; }
    pub fn scopeAll(m: *const Model) bool { return m.filter == .all; }
    pub fn scopeArchived(m: *const Model) bool { return m.filter == .archived; }
    pub fn allCount(m: *const Model) usize { var n: usize = 0; for (m.sessions()) |s| { if (!s.isArchived()) n += 1; } return n; }
    pub fn archivedCount(m: *const Model) usize { return m.sessions().len - m.allCount(); }
    pub fn activeCount(m: *const Model) usize { var n: usize = 0; for (m.sessions()) |s| { if (s.alive) n += 1; } return n; }
    pub fn attentionCount(m: *const Model) usize { var n: usize = 0; for (m.sessions()) |s| { if (s.needsAttention()) n += 1; } return n; }
    pub fn inScope(m: *const Model, s: Session) bool { return if (m.filter == .archived) s.isArchived() else !s.isArchived(); }
    pub fn matches(m: *const Model, s: Session) bool {
        const q = std.mem.trim(u8, m.search_buffer.text(), " \t");
        return m.inScope(s) and (q.len == 0 or contains(s.title, q) or contains(s.project, q) or contains(s.provider, q) or contains(s.providerName(), q) or (eq(s.owner, "grok") and contains("grok", q)));
    }
    fn isCollapsed(m: *const Model, g: Group) bool { return !m.searching() and m.collapsed[@intFromEnum(g)]; }
    /// Session rows that can appear on a page: matching and not in a collapsed section.
    pub fn filteredCount(m: *const Model) usize {
        var n: usize = 0;
        for (m.sessions()) |s| { if (m.matches(s) and !m.isCollapsed(s.group())) n += 1; }
        return n;
    }
    pub fn matchCount(m: *const Model) usize { var n: usize = 0; for (m.sessions()) |s| { if (m.matches(s)) n += 1; } return n; }
    fn groupCount(m: *const Model, g: Group) usize { var n: usize = 0; for (m.sessions()) |s| { if (s.group() == g and m.matches(s)) n += 1; } return n; }
    /// Visible session IDs in sidebar order across all pages.
    pub fn orderedIds(m: *const Model, arena: std.mem.Allocator) []const []const u8 {
        const out = arena.alloc([]const u8, m.sessions().len) catch return &.{};
        var count: usize = 0;
        for (std.enums.values(Group)) |g| {
            if (m.isCollapsed(g)) continue;
            for (m.sessions()) |s| { if (s.group() == g and m.matches(s)) { out[count] = s.id; count += 1; } }
        }
        return out[0..count];
    }
    pub fn visible(m: *const Model, arena: std.mem.Allocator) []const Row {
        const out = arena.alloc(Row, page_size + 4) catch return &.{};
        const first = m.page * page_size;
        const last_page = m.pageCount() - 1;
        var seen: usize = 0;
        var count: usize = 0;
        for (std.enums.values(Group)) |g| {
            const total = m.groupCount(g);
            if (total == 0) continue;
            const header: Row = .{ .id = @tagName(g), .header = true, .group = g, .collapsed = m.isCollapsed(g), .heading = std.fmt.allocPrint(arena, "{s} · {d}", .{ groupName(g), total }) catch "" };
            if (m.isCollapsed(g)) {
                if (seen >= first and (seen < first + page_size or m.page == last_page)) { out[count] = header; count += 1; }
                continue;
            }
            var headed = false;
            for (m.sessions()) |s| {
                if (s.group() != g or !m.matches(s)) continue;
                seen += 1;
                if (seen <= first or seen > first + page_size) continue;
                if (!headed) { out[count] = header; count += 1; headed = true; }
                out[count] = m.row(arena, s);
                count += 1;
            }
        }
        return out[0..count];
    }
    fn row(m: *const Model, arena: std.mem.Allocator, s: Session) Row {
        return .{
            .id = s.id, .title = s.title, .status = s.statusName(), .when = relativeTime(arena, m.now_s, s.updatedAt),
            .meta = std.fmt.allocPrint(arena, "{s} · {s}", .{ s.providerName(), std.fs.path.basename(s.project) }) catch "",
            .selected = eq(s.id, m.selection.text()), .failed = s.failed(), .attention = s.needsAttention() and !s.failed(),
            .working = s.working(), .ready = s.ready(), .archived = s.isArchived(), .alive = s.alive, .grok = !eq(s.owner, "human"),
        };
    }
    pub fn emptyTitle(m: *const Model) []const u8 {
        if (m.snapshot == null) return "Caricamento delle sessioni...";
        if (m.searching()) return "Nessun risultato";
        return if (m.filter == .archived) "Archivio vuoto" else "Nessuna sessione";
    }
    pub fn emptyHint(m: *const Model) []const u8 {
        if (m.snapshot == null) return "Le CLI restano attive anche mentre Harbor si collega al gestore.";
        if (m.searching()) return "Cerca per nome, progetto, agente o Grok.";
        return if (m.filter == .archived) "Le sessioni chiuse che archivi compaiono qui." else "Crea una sessione con Claude Code o Codex.";
    }
    pub fn pageCount(m: *const Model) usize { return @max(1, (m.filteredCount() + page_size - 1) / page_size); }
    pub fn showPager(m: *const Model) bool { return m.pageCount() > 1; }
    pub fn pageLabel(m: *const Model, arena: std.mem.Allocator) []const u8 { return std.fmt.allocPrint(arena, "Pagina {d} di {d}", .{ m.page + 1, m.pageCount() }) catch ""; }
    pub fn listSummary(m: *const Model, arena: std.mem.Allocator) []const u8 {
        if (m.snapshot == null) return "";
        const n = m.matchCount();
        if (m.searching()) return std.fmt.allocPrint(arena, "{d} {s}", .{ n, if (n == 1) "risultato" else "risultati" }) catch "";
        return std.fmt.allocPrint(arena, "{d} {s}", .{ n, if (n == 1) "sessione" else "sessioni" }) catch "";
    }
    pub fn firstPage(m: *const Model) bool { return m.page == 0; }
    pub fn lastPage(m: *const Model) bool { return (m.page + 1) * page_size >= m.filteredCount(); }
    /// Default selection: what needs a human first, then live work, never the archive.
    pub fn preferred(m: *const Model) ?[]const u8 {
        for ([_]Group{ .attention, .active, .closed, .archived }) |g| { for (m.sessions()) |s| { if (s.group() == g) return s.id; } }
        return null;
    }

    // New session form.
    pub fn formTitle(m: *const Model) []const u8 { return m.title_buffer.text(); }
    pub fn formProject(m: *const Model) []const u8 { return m.project_buffer.text(); }
    pub fn formPrompt(m: *const Model) []const u8 { return m.prompt_buffer.text(); }
    pub fn formCliArgs(m: *const Model) []const u8 { return m.cli_args_buffer.text(); }
    pub fn renameText(m: *const Model) []const u8 { return m.rename_buffer.text(); }
    pub fn formCodex(m: *const Model) bool { return !m.form_claude; }
    pub fn effectiveTitle(m: *const Model) []const u8 {
        const title = std.mem.trim(u8, m.formTitle(), " \t\r\n");
        if (title.len > 0) return m.formTitle();
        return std.fs.path.basename(std.mem.trimEnd(u8, m.formProject(), "/"));
    }
    pub fn titlePlaceholder(m: *const Model, arena: std.mem.Allocator) []const u8 {
        const name = std.fs.path.basename(std.mem.trimEnd(u8, m.formProject(), "/"));
        if (name.len == 0) return "Es. Revisione del checkout";
        return std.fmt.allocPrint(arena, "Predefinito: {s}", .{name}) catch "Es. Revisione del checkout";
    }
    pub fn recentProjects(m: *const Model, arena: std.mem.Allocator) []const ProjectChip {
        const out = arena.alloc(ProjectChip, 4) catch return &.{};
        var count: usize = 0;
        outer: for (m.sessions()) |s| {
            if (s.project.len == 0 or count == out.len) continue;
            for (out[0..count]) |chip| { if (eq(chip.path, s.project)) continue :outer; }
            out[count] = .{ .path = s.project, .name = std.fs.path.basename(s.project) };
            count += 1;
        }
        return out[0..count];
    }
    pub fn hasRecentProjects(m: *const Model) bool { for (m.sessions()) |s| { if (s.project.len > 0) return true; } return false; }
    pub fn cannotCreate(m: *const Model) bool { return m.busy or std.mem.trim(u8, m.formProject(), " \t\r\n").len == 0 or m.effectiveTitle().len == 0 or m.formHasTruncation(); }
    pub fn formHasTruncation(m: *const Model) bool { return m.project_buffer.truncated or m.title_buffer.truncated or m.prompt_buffer.truncated or m.cli_args_buffer.truncated; }
    pub fn ptyKey(m: *const Model) u64 { return m.terminal_key; }
    pub fn terminalVisible(m: *const Model) bool { return m.alive() and !m.creating; }
};
pub const Effects = sdk.Effects(Msg);
pub const AppUi = canvas.Ui(Msg);
pub const app_markup = @embedFile("app.native");
const HarborApp = sdk.UiApp(Model, Msg);
fn eq(a: []const u8, b: []const u8) bool { return std.mem.eql(u8, a, b); }
fn contains(a: []const u8, b: []const u8) bool { if (b.len > a.len) return false; for (0..a.len - b.len + 1) |i| { if (std.ascii.eqlIgnoreCase(a[i .. i + b.len], b)) return true; } return false; }
fn groupName(g: Group) []const u8 {
    return switch (g) { .attention => "Da controllare", .active => "Attive", .closed => "Chiuse", .archived => "Archiviate" };
}
fn displayPath(arena: std.mem.Allocator, value: []const u8) []const u8 {
    if (home_directory.len > 1 and std.mem.startsWith(u8, value, home_directory) and (value.len == home_directory.len or value[home_directory.len] == '/'))
        return std.fmt.allocPrint(arena, "~{s}", .{value[home_directory.len..]}) catch value;
    return value;
}
/// Parses the broker's ISO-8601 UTC timestamps ("2026-10-19T07:14:26.881Z") to Unix seconds.
pub fn parseTimestamp(value: ?[]const u8) ?i64 {
    const t = value orelse return null;
    if (t.len < 19 or t[4] != '-' or t[7] != '-' or t[10] != 'T' or t[13] != ':' or t[16] != ':') return null;
    const year = std.fmt.parseInt(i64, t[0..4], 10) catch return null;
    const month = std.fmt.parseInt(i64, t[5..7], 10) catch return null;
    const day = std.fmt.parseInt(i64, t[8..10], 10) catch return null;
    const hour = std.fmt.parseInt(i64, t[11..13], 10) catch return null;
    const minute = std.fmt.parseInt(i64, t[14..16], 10) catch return null;
    const second = std.fmt.parseInt(i64, t[17..19], 10) catch return null;
    if (month < 1 or month > 12 or day < 1 or day > 31) return null;
    // Days from civil (Howard Hinnant), proleptic Gregorian.
    const y = if (month <= 2) year - 1 else year;
    const era = @divFloor(y, 400);
    const yoe = y - era * 400;
    const mp = @mod(month + 9, 12);
    const doy = @divFloor(153 * mp + 2, 5) + day - 1;
    const doe = yoe * 365 + @divFloor(yoe, 4) - @divFloor(yoe, 100) + doy;
    const days = era * 146097 + doe - 719468;
    return days * 86400 + hour * 3600 + minute * 60 + second;
}
const month_names = [_][]const u8{ "gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic" };
pub fn relativeTime(arena: std.mem.Allocator, now: i64, value: ?[]const u8) []const u8 {
    const then = parseTimestamp(value) orelse return "";
    if (now <= 0) return "";
    const delta = @max(0, now - then);
    if (delta < 45) return "adesso";
    if (delta < 3600) return std.fmt.allocPrint(arena, "{d} min", .{@max(1, @divFloor(delta + 30, 60))}) catch "";
    if (delta < 86400) return std.fmt.allocPrint(arena, "{d} h", .{@divFloor(delta, 3600)}) catch "";
    if (delta < 2 * 86400) return "ieri";
    if (delta < 7 * 86400) return std.fmt.allocPrint(arena, "{d} g", .{@divFloor(delta, 86400)}) catch "";
    const civil = civilDate(then);
    return std.fmt.allocPrint(arena, "{d} {s}", .{ civil.day, month_names[civil.month - 1] }) catch "";
}
fn civilDate(seconds: i64) struct { year: i64, month: usize, day: i64 } {
    const z = @divFloor(seconds, 86400) + 719468;
    const era = @divFloor(z, 146097);
    const doe = z - era * 146097;
    const yoe = @divFloor(doe - @divFloor(doe, 1460) + @divFloor(doe, 36524) - @divFloor(doe, 146096), 365);
    const doy = doe - (365 * yoe + @divFloor(yoe, 4) - @divFloor(yoe, 100));
    const mp = @divFloor(5 * doy + 2, 153);
    const day = doy - @divFloor(153 * mp + 2, 5) + 1;
    const month: i64 = if (mp < 10) mp + 3 else mp - 9;
    return .{ .year = yoe + era * 400 + @as(i64, if (month <= 2) 1 else 0), .month = @intCast(month), .day = day };
}
fn absoluteTime(arena: std.mem.Allocator, value: ?[]const u8) []const u8 {
    const seconds = parseTimestamp(value) orelse return "Non disponibile";
    const civil = civilDate(seconds);
    const in_day = @mod(seconds, 86400);
    return std.fmt.allocPrint(arena, "{d} {s} {d}, {d:0>2}:{d:0>2} UTC", .{ civil.day, month_names[civil.month - 1], civil.year, @as(u64, @intCast(@divFloor(in_day, 3600))), @as(u64, @intCast(@divFloor(@mod(in_day, 3600), 60))) }) catch "";
}
fn setNotice(m: *Model, fx: *Effects, kind: NoticeKind, text: []const u8) void {
    m.notice_buffer.set(text);
    m.notice_kind = kind;
    if (kind == .failure) fx.cancelTimer(2) else fx.startTimer(.{ .key = 2, .interval_ms = 5000, .on_fire = Effects.timerMsg(.notice_expired) });
}
fn notice(m: *Model, fx: *Effects, text: []const u8) void { setNotice(m, fx, .info, text); }
fn failure(m: *Model, fx: *Effects, text: []const u8) void { setNotice(m, fx, .failure, text); }
fn success(m: *Model, fx: *Effects, text: []const u8) void { setNotice(m, fx, .success, text); }
/// Translates broker error codes into actionable Italian copy; unknown codes keep the broker message.
fn errorCopy(code: []const u8, message: []const u8) []const u8 {
    if (eq(code, "CONTROL_DENIED")) return "Grok ha il controllo di questa sessione. Prendi il controllo prima di agire.";
    if (eq(code, "CONTROL_CHANGED")) return "Il controllo è cambiato durante l'operazione. Nessun input è stato inviato: verifica il terminale.";
    if (eq(code, "CLI_NOT_READY")) return "La CLI non è pronta. Apri il terminale per risolvere fiducia, permessi o hook.";
    if (eq(code, "REQUEST_UNRESOLVED")) return "Una consegna precedente non ha ricevuta. Controlla il terminale prima di inviare altro.";
    if (eq(code, "WORKTREE_MISSING")) return "La cartella di lavoro salvata non esiste più. Harbor non riprende in un'altra cartella.";
    if (eq(code, "DEPENDENCY_MISSING")) return "Manca una dipendenza (tmux o la CLI dell'agente). Esegui harbor doctor per i dettagli.";
    if (eq(code, "INVALID_PROJECT")) return "La cartella del progetto non esiste o non è una directory.";
    if (eq(code, "INVALID_CLI_ARGS") or eq(code, "RESERVED_CLI_ARGUMENT")) return message;
    if (eq(code, "DAEMON_UNAVAILABLE") or eq(code, "RPC_TIMEOUT")) return "Il gestore non risponde. Le CLI restano attive; riprova tra poco.";
    if (eq(code, "CLIENT_CONTROL_FAILED")) return "Il terminale non ha confermato il cambio di controllo. Il controllo precedente resta valido.";
    return message;
}
fn clearCreateIntent(m: *Model) void { m.create_id.clear(); m.create_file_path.clear(); m.create_intent_valid = false; }
fn createIntent(m: *Model, args_json: []const u8, prompt: []const u8) void {
    var payload = std.crypto.hash.sha2.Sha256.init(.{});
    for ([_][]const u8{ if (m.form_claude) "claude" else "codex", m.formProject(), m.effectiveTitle(), prompt, args_json }) |part| {
        var len: [8]u8 = undefined; std.mem.writeInt(u64, &len, @intCast(part.len), .little);
        payload.update(&len); payload.update(part);
    }
    const digest = payload.finalResult();
    if (m.create_intent_valid and std.mem.eql(u8, &m.create_payload_hash, &digest)) return;
    intent_sequence += 1;
    var sequence: [8]u8 = undefined; std.mem.writeInt(u64, &sequence, intent_sequence, .little);
    var unique = std.crypto.hash.sha2.Sha256.init(.{}); unique.update(&intent_entropy); unique.update(&sequence);
    var bytes = unique.finalResult(); bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = "0123456789abcdef";
    var uuid: [36]u8 = undefined; var out: usize = 0;
    for (bytes[0..16], 0..) |byte, i| {
        if (i == 4 or i == 6 or i == 8 or i == 10) { uuid[out] = '-'; out += 1; }
        uuid[out] = hex[byte >> 4]; uuid[out + 1] = hex[byte & 0x0f]; out += 2;
    }
    m.create_id.set(&uuid); m.create_payload_hash = digest; m.create_intent_valid = true;
}
fn run(m: *Model, fx: *Effects, args: []const []const u8) void {
    if (m.busy) return;
    var bytes = node_path.len + cli_path.len; for (args) |arg| bytes += arg.len;
    if (args.len + 2 > sdk.max_effect_argv or bytes > sdk.max_effect_argv_bytes) { failure(m, fx, "I percorsi dell'app superano il limite del terminale. Usa una posizione più breve."); return; }
    m.busy = true; m.operation_session.set(m.selectedId());
    var argv: [20][]const u8 = undefined; argv[0] = node_path; argv[1] = cli_path;
    for (args, 0..) |arg, i| argv[i + 2] = arg;
    fx.spawn(.{ .key = 101, .argv = argv[0 .. args.len + 2], .output = .collect, .on_exit = Effects.exitMsg(.command_done) });
}
fn writeCreateRequest(m: *Model, fx: *Effects, cli_args: []const []const u8, prompt: []const u8) void {
    const path = std.fmt.allocPrint(alloc, "{s}/{s}.json", .{ request_directory, m.create_id.text() }) catch { failure(m, fx, "Impossibile preparare la richiesta."); return; };
    defer alloc.free(path);
    m.create_file_path.set(path);
    if (m.create_file_path.truncated) { failure(m, fx, "Il percorso dei dati dell'app è troppo lungo."); return; }
    var json: std.Io.Writer.Allocating = .init(alloc); defer json.deinit();
    std.json.Stringify.value(.{ .id = m.create_id.text(), .requestId = m.create_id.text(), .provider = if (m.form_claude) "claude" else "codex", .project = m.formProject(), .title = m.effectiveTitle(), .owner = "human", .text = prompt, .cliArgs = cli_args }, .{}, &json.writer) catch { failure(m, fx, "Impossibile preparare la richiesta."); return; };
    m.busy = true;
    fx.writeFile(.{ .key = 108, .path = m.create_file_path.text(), .bytes = json.written(), .on_result = Effects.fileMsg(.create_file_saved) });
}
fn watch(m: *Model, fx: *Effects) void {
    if (m.watching) return; m.watching = true;
    fx.spawn(.{ .key = 100, .argv = &.{ node_path, cli_path, "watch", "--compact", "--include-archived", "--chunked" }, .max_line_bytes = max_snapshot_line_bytes, .on_line = Effects.lineMsg(.status_line), .on_exit = Effects.exitMsg(.watch_done) });
}
fn saveSelection(m: *Model, fx: *Effects) void {
    if (preferences_path.len > 0) fx.writeFile(.{ .key = 104, .path = preferences_path, .bytes = m.selection.text(), .on_result = Effects.fileMsg(.prefs_saved) });
}
fn syncTerminal(m: *Model, fx: *Effects) void {
    const wants = m.alive() and !m.creating;
    const run_id = if (m.selected()) |s| s.runId orelse "" else "";
    if (m.attached and (!wants or !eq(m.attached_id.text(), m.selection.text()) or !eq(m.attached_run_id.text(), run_id) or m.attachment_human != m.human())) {
        if (!m.detaching) { m.detaching = true; fx.ptyKill(m.terminal_key); }
        return;
    }
    if (m.attached or m.detaching or m.attach_wait or !wants or m.cols == 0 or m.rows == 0) return;
    // Native SDK retains one emulator per key (four total). Reuse the visible
    // terminal's key after exit: its first output resets the ended emulator;
    // the effect engine rejects stale output using its internal generation.
    m.attached = true; m.attached_id.set(m.selection.text()); m.attached_run_id.set(run_id); m.attachment_human = m.human(); m.first_output = true;
    fx.ptySpawn(.{ .key = m.terminal_key, .argv = &.{ node_path, cli_path, "attach", m.selection.text() }, .cols = m.cols, .rows = m.rows, .term = "xterm-256color", .on_event = Effects.ptyMsg(.terminal_event) });
}
fn discardPending(m: *Model) void {
    if (m.pending_snapshot) |*p| p.deinit();
    m.pending_snapshot = null;
}
fn rejectSnapshot(m: *Model, fx: *Effects) void {
    discardPending(m);
    m.connected = false;
    // A watch sends only changed state. Restart it to recover a dropped chunk even
    // when the broker's sessions have not changed in the meantime.
    if (m.watching) fx.cancel(100);
}
fn snapshot(m: *Model, fx: *Effects, bytes: []const u8) void {
    if (bytes.len > max_snapshot_line_bytes) { rejectSnapshot(m, fx); return; }
    const parsed = std.json.parseFromSlice(SnapshotHeader, alloc, bytes, .{ .ignore_unknown_fields = true, .allocate = .alloc_always }) catch { rejectSnapshot(m, fx); return; };
    defer parsed.deinit();
    const frame = parsed.value;
    if (frame.snapshotId.len == 0 or frame.snapshotId.len > 128) { rejectSnapshot(m, fx); return; }
    if (eq(frame.type, "snapshot-begin")) {
        const count = frame.count orelse { rejectSnapshot(m, fx); return; };
        if (count > max_snapshot_bytes) { rejectSnapshot(m, fx); return; }
        discardPending(m);
        m.pending_snapshot = PendingSnapshot.init(frame.snapshotId, count, bytes.len + 1) catch { rejectSnapshot(m, fx); return; };
        return;
    }
    const p = if (m.pending_snapshot) |*value| value else { rejectSnapshot(m, fx); return; };
    if (!eq(frame.snapshotId, p.id) or bytes.len + 1 > max_snapshot_bytes - p.bytes) { rejectSnapshot(m, fx); return; }
    p.bytes += bytes.len + 1;
    if (eq(frame.type, "snapshot-chunk")) {
        const chunk = std.json.parseFromSliceLeaky(Snapshot, p.arena.allocator(), bytes, .{ .ignore_unknown_fields = true, .allocate = .alloc_always }) catch { rejectSnapshot(m, fx); return; };
        if (chunk.sessions.len > p.expected_count - p.sessions.items.len) { rejectSnapshot(m, fx); return; }
        p.sessions.appendSlice(p.arena.allocator(), chunk.sessions) catch { rejectSnapshot(m, fx); return; };
        return;
    }
    if (!eq(frame.type, "snapshot-end") or p.sessions.items.len != p.expected_count) { rejectSnapshot(m, fx); return; }
    const list = p.sessions.toOwnedSlice(p.arena.allocator()) catch { rejectSnapshot(m, fx); return; };
    const complete: std.json.Parsed(Snapshot) = .{ .arena = p.arena, .value = .{ .sessions = list } };
    m.pending_snapshot = null; // Ownership of all chunk strings moves with the arena.
    const first = m.snapshot == null;
    if (m.snapshot) |old| old.deinit();
    m.snapshot = complete; m.connected = true;
    // Startup never lands on an archived conversation remembered from last time.
    const stale = if (m.selected()) |s| first and s.isArchived() else true;
    if (stale) { if (m.preferred()) |id| { m.selection.set(id); saveSelection(m, fx); revealSelection(m); } }
    if (m.page >= m.pageCount()) m.page = 0;
    syncTerminal(m, fx);
}
fn boot(m: *Model, fx: *Effects) void {
    m.now_s = @divFloor(fx.wallMs(), 1000);
    if (preferences_path.len > 0) fx.readFile(.{ .key = 103, .path = preferences_path, .on_result = Effects.fileMsg(.prefs_loaded) });
    watch(m, fx);
    fx.startTimer(.{ .key = 1, .interval_ms = 3000, .mode = .repeating, .on_fire = Effects.timerMsg(.tick) });
}
fn select(m: *Model, fx: *Effects, id: []const u8) void {
    m.selection.set(id); m.creating = false; m.renaming = false; m.scrollback = 0; m.focus_terminal = true;
    saveSelection(m, fx); syncTerminal(m, fx);
}
/// Moves the page so that the selected session is on screen.
fn revealSelection(m: *Model) void {
    var buffer = std.heap.ArenaAllocator.init(alloc); defer buffer.deinit();
    const ids = m.orderedIds(buffer.allocator());
    for (ids, 0..) |id, i| { if (eq(id, m.selection.text())) { m.page = i / page_size; return; } }
}
fn step(m: *Model, fx: *Effects, forward: bool) void {
    var buffer = std.heap.ArenaAllocator.init(alloc); defer buffer.deinit();
    const ids = m.orderedIds(buffer.allocator());
    if (ids.len == 0) return;
    var index: usize = if (forward) 0 else ids.len - 1;
    for (ids, 0..) |id, i| { if (eq(id, m.selection.text())) { index = if (forward) @min(ids.len - 1, i + 1) else i -| 1; break; } }
    select(m, fx, ids[index]);
    m.page = index / page_size;
}
fn selectOnPage(m: *Model, fx: *Effects, n: usize) void {
    var buffer = std.heap.ArenaAllocator.init(alloc); defer buffer.deinit();
    var count: usize = 0;
    for (m.visible(buffer.allocator())) |r| {
        if (r.header) continue;
        if (count == n) { select(m, fx, r.id); return; }
        count += 1;
    }
}
/// Applies a session context-menu command to that row's session.
fn rowAction(m: *Model, fx: *Effects, id: []const u8, msg: Msg) void {
    if (m.busy) return;
    if (!eq(id, m.selection.text())) select(m, fx, id);
    update(m, msg, fx);
}
pub fn onCommand(name: []const u8) ?Msg {
    if (eq(name, "session.new")) return .new_session;
    if (eq(name, "session.search")) return .focus_search;
    if (eq(name, "session.details")) return .show_details;
    if (eq(name, "session.next")) return .select_next;
    if (eq(name, "session.previous")) return .select_previous;
    if (name.len == 9 and std.mem.startsWith(u8, name, "session.") and name[8] >= '1' and name[8] <= '9') return .{ .select_index = name[8] - '1' };
    return null;
}
pub fn onAppearance(appearance: sdk.platform.Appearance) ?Msg { return .{ .appearance = appearance }; }
pub fn onChrome(chrome: sdk.platform.WindowChrome) ?Msg { return .{ .chrome = chrome }; }
pub fn update(m: *Model, msg: Msg, fx: *Effects) void {
    m.focus_terminal = false;
    m.search_focus = false;
    switch (msg) {
        .select => |id| select(m, fx, id),
        .select_index => |n| selectOnPage(m, fx, n),
        .select_next => step(m, fx, true),
        .select_previous => step(m, fx, false),
        .filter_all, .filter_archived => { m.filter = if (std.meta.activeTag(msg) == .filter_archived) .archived else .all; m.page = 0; },
        .toggle_group => |g| { m.collapsed[@intFromEnum(g)] = !m.collapsed[@intFromEnum(g)]; if (m.page >= m.pageCount()) m.page = m.pageCount() - 1; },
        .search_edit => |e| { m.search_buffer.apply(e); m.page = 0; },
        .clear_search => { m.search_buffer.clear(); m.page = 0; revealSelection(m); },
        .focus_search => m.search_focus = true,
        .previous_page => { if (m.page > 0) m.page -= 1; },
        .next_page => { if (!m.lastPage()) m.page += 1; },
        .new_session, .new_claude, .new_codex => {
            if (m.busy) return;
            m.creating = true; m.renaming = false; m.advanced = false; clearCreateIntent(m);
            m.title_buffer.clear(); m.prompt_buffer.clear(); m.cli_args_buffer.clear();
            if (m.selected()) |s| { m.project_buffer.set(s.project); m.form_claude = eq(s.provider, "claude"); }
            if (std.meta.activeTag(msg) == .new_claude) m.form_claude = true;
            if (std.meta.activeTag(msg) == .new_codex) m.form_claude = false;
            syncTerminal(m, fx);
        },
        .cancel_form => { if (m.busy) return; m.creating = false; clearCreateIntent(m); m.focus_terminal = true; syncTerminal(m, fx); },
        .title_edit => |e| m.title_buffer.apply(e), .project_edit => |e| m.project_buffer.apply(e), .prompt_edit => |e| m.prompt_buffer.apply(e),
        .cli_args_edit => |e| m.cli_args_buffer.apply(e), .toggle_advanced => m.advanced = !m.advanced,
        .pick_project => |p| m.project_buffer.set(p),
        .choose_provider => |p| m.form_claude = eq(p, "claude"),
        .choose_folder => { fx.spawn(.{ .key = 105, .argv = &.{ node_path, gui_path, "folder" }, .output = .collect, .on_exit = Effects.exitMsg(.folder_done) }); },
        .folder_done => |r| { if (r.code == 0 and r.reason == .exited) { const p = std.mem.trim(u8, r.output, "\r\n"); if (p.len > 0) m.project_buffer.set(p); } else notice(m, fx, "Selezione cartella annullata o non disponibile."); },
        .create_session => {
            if (m.cannotCreate()) return;
            const cli_args = std.mem.trim(u8, m.formCliArgs(), " \t\r\n");
            const args_json = if (cli_args.len == 0) "[]" else cli_args;
            const checked = std.json.parseFromSlice([]const []const u8, alloc, args_json, .{}) catch { failure(m, fx, "Le opzioni devono essere un array JSON di stringhe, per esempio [\"--model\",\"nome-modello\"]."); return; };
            defer checked.deinit();
            const prompt = if (m.prompt_buffer.isEmpty()) "Rispondi soltanto PRONTO. Non usare strumenti e non modificare file." else m.formPrompt();
            createIntent(m, args_json, prompt);
            m.action = .create; notice(m, fx, "Creazione della sessione...");
            writeCreateRequest(m, fx, checked.value, prompt);
        },
        .create_file_saved => |r| { m.busy = false; if (r.outcome == .ok) { run(m, fx, &.{ "create", "--request-file", m.create_file_path.text() }); } else failure(m, fx, "La richiesta non è stata salvata. Riprova per continuare la stessa creazione."); },
        .take_control => { if (!m.hasSelection() or m.busy or m.human()) return; m.action = .control; run(m, fx, &.{ "control", m.selectedId(), "human" }); },
        .release_control => { if (!m.hasSelection() or m.cannotRelease()) return; m.action = .control; run(m, fx, &.{ "control", m.selectedId(), "grok" }); },
        .start_session => { if (!m.hasSelection() or !m.canStart() or m.cannotStart()) return; m.action = .start; notice(m, fx, "Ripresa della conversazione..."); run(m, fx, &.{ "start", m.selectedId(), "--actor", "human" }); },
        .stop_session => { if (m.cannotStop()) return; m.action = .stop; notice(m, fx, "Chiusura della CLI. La conversazione rimane salvata."); run(m, fx, &.{ "stop", m.selectedId(), "--actor", "human" }); },
        .archive_session => { if (!m.hasSelection() or m.alive() or m.archived() or m.busy) return; m.action = .archive; run(m, fx, &.{ "archive", m.selectedId() }); },
        .restore_session => { if (!m.archived() or m.busy) return; m.action = .restore; run(m, fx, &.{ "restore", m.selectedId() }); },
        .rename_session => { if (m.selected()) |s| { m.rename_buffer.set(s.title); m.renaming = true; } },
        .rename_edit => |e| m.rename_buffer.apply(e),
        .save_name => { if (m.cannotSaveName()) return; m.action = .rename; run(m, fx, &.{ "rename", m.selectedId(), "--title", m.renameText() }); },
        .cancel_name => m.renaming = false,
        .show_details => { if (m.hasSelection()) m.details = !m.details; },
        .reconnect => { if (m.attached and !m.detaching) { m.detaching = true; fx.ptyKill(m.terminal_key); } else syncTerminal(m, fx); },
        .open_terminal => { if (!m.hasSelection() or m.busy) return; m.action = .external; run(m, fx, &.{ "control", m.selectedId(), "human" }); },
        .copy_id => { if (m.hasNativeId()) fx.writeClipboard(.{ .key = 106, .text = m.nativeId(), .on_result = Effects.clipboardMsg(.copied) }); },
        .copy_session_id => { if (m.hasSelection()) fx.writeClipboard(.{ .key = 106, .text = m.selectedId(), .on_result = Effects.clipboardMsg(.copied) }); },
        .copied => |r| { if (r.outcome == .ok) success(m, fx, "Identificativo copiato.") else failure(m, fx, "Impossibile copiare l'identificativo."); },
        .dismiss_notice => { m.notice_buffer.clear(); fx.cancelTimer(2); },
        .notice_expired => |t| { if (t.outcome == .fired and m.notice_kind != .failure) m.notice_buffer.clear(); },
        .row_rename => |id| rowAction(m, fx, id, .rename_session),
        .row_take => |id| rowAction(m, fx, id, .take_control),
        .row_release => |id| rowAction(m, fx, id, .release_control),
        .row_terminal => |id| rowAction(m, fx, id, .open_terminal),
        .row_copy => |id| rowAction(m, fx, id, .copy_id),
        .row_start => |id| rowAction(m, fx, id, .start_session),
        .row_stop => |id| rowAction(m, fx, id, .stop_session),
        .row_archive => |id| rowAction(m, fx, id, .archive_session),
        .row_restore => |id| rowAction(m, fx, id, .restore_session),
        .status_line => |line| { if (line.truncated or line.dropped_before > 0) { rejectSnapshot(m, fx); } else snapshot(m, fx, line.line); },
        .watch_done => { discardPending(m); m.watching = false; m.connected = false; },
        .tick => |t| { if (t.outcome == .fired) { m.now_s = @divFloor(fx.wallMs(), 1000); m.attach_wait = false; watch(m, fx); syncTerminal(m, fx); } },
        .command_done => |r| {
            m.busy = false;
            if (r.reason != .exited or r.code != 0 or r.output_truncated) {
                const parsed = std.json.parseFromSlice(struct { @"error": struct { code: []const u8 = "", message: []const u8 } }, alloc, r.output, .{ .ignore_unknown_fields = true }) catch null;
                if (parsed) |f| { defer f.deinit(); failure(m, fx, errorCopy(f.value.@"error".code, f.value.@"error".message)); } else failure(m, fx, if (r.stderr_tail.len > 0) r.stderr_tail else "Operazione non completata. Verifica il terminale prima di riprovare.");
                return;
            }
            const parsed = std.json.parseFromSlice(struct { session: ?Session = null }, alloc, r.output, .{ .ignore_unknown_fields = true }) catch null;
            if (parsed) |p| {
                defer p.deinit();
                if (m.action == .create) {
                    const created = p.value.session orelse { failure(m, fx, "Risposta incompleta. Riprova per verificare la stessa creazione."); return; };
                    m.creating = false; clearCreateIntent(m); m.title_buffer.clear(); m.prompt_buffer.clear(); m.cli_args_buffer.clear();
                    m.filter = .all; m.search_buffer.clear();
                    select(m, fx, created.id);
                    revealSelection(m);
                }
            } else if (m.action == .create) { failure(m, fx, "Risposta incompleta. Riprova per verificare la stessa creazione."); return; }
            m.renaming = false;
            if (m.action == .external) { fx.spawn(.{ .key = 107, .argv = &.{ node_path, gui_path, "terminal", m.operation_session.text() }, .output = .collect, .on_exit = Effects.exitMsg(.folder_done) }); }
            success(m, fx, switch (m.action) {
                .create => "Sessione avviata.",
                .start => "Sessione ripresa. Il terminale si ricollega.",
                .control => if (m.human()) "Hai il controllo. Il terminale accetta la tastiera." else "Controllo passato a Grok. Il terminale è in sola lettura.",
                .external => "Sessione aperta in Terminale.",
                .stop => "CLI chiusa. La conversazione è salvata.",
                .archive => "Sessione archiviata.",
                .restore => "Sessione ripristinata.",
                .rename => "Nome aggiornato.",
                .other => "Operazione completata.",
            });
            if (m.action == .control) m.focus_terminal = true;
        },
        .terminal_state => |s| { m.cols = s.cols; m.rows = s.rows; m.scrollback = s.scrollback; if (m.attached) fx.ptyResize(m.terminal_key, s.cols, s.rows); syncTerminal(m, fx); },
        .terminal_event => |e| {
            if (e.key != m.terminal_key) return;
            if (e.kind == .output) { if (m.first_output) { fx.ptyResize(e.key, m.cols, m.rows); m.first_output = false; } return; }
            if (e.kind == .exit) { const wanted = m.detaching; m.attached = false; m.detaching = false; m.attach_wait = !wanted; if (wanted) syncTerminal(m, fx); }
        },
        .prefs_loaded => |r| {
            if (r.outcome != .ok or r.bytes.len > 64) return;
            const previous = m.selection.text().len > 0;
            m.selection.set(std.mem.trim(u8, r.bytes, "\r\n"));
            // A remembered archived conversation must not replace a live default.
            if (m.selected()) |s| { if (s.isArchived() and previous) { if (m.preferred()) |id| m.selection.set(id); } }
            revealSelection(m); syncTerminal(m, fx);
        },
        .prefs_saved => |r| { if (r.outcome != .ok) failure(m, fx, "La selezione non è stata salvata. Le sessioni restano nel gestore."); },
        .appearance => |a| { m.dark = a.color_scheme == .dark; m.high_contrast = a.high_contrast; },
        .chrome => |c| { m.chrome_left = c.insets.left; m.chrome_top = c.insets.top; m.chrome_center = if (c.buttons.height > 0) c.buttons.y + c.buttons.height / 2 else 0; },
    }
}
/// Calm neutral shell with one green identity hue; the terminal inherits background and text.
pub fn tokens(m: *const Model) canvas.DesignTokens {
    var t = canvas.DesignTokens.theme(.{ .color_scheme = if (m.dark) .dark else .light, .contrast = if (m.high_contrast) .high else .standard });
    t.typography.heading_size = 22;
    t.typography.title_size = 16;
    if (m.high_contrast) return t;
    const c = &t.colors;
    if (m.dark) {
        c.background = canvas.Color.rgb8(18, 21, 20); c.surface = canvas.Color.rgb8(25, 29, 28); c.surface_subtle = canvas.Color.rgb8(22, 26, 25);
        c.surface_pressed = canvas.Color.rgb8(36, 51, 47); c.text = canvas.Color.rgb8(229, 234, 231); c.text_muted = canvas.Color.rgb8(143, 154, 149);
        c.border = canvas.Color.rgb8(44, 50, 48); c.success = canvas.Color.rgb8(74, 186, 128); c.warning = canvas.Color.rgb8(232, 168, 64);
        c.destructive = canvas.Color.rgb8(240, 98, 92); c.info = canvas.Color.rgb8(150, 140, 245);
        t = t.withOverrides(canvas.accentOverrides(canvas.Color.rgb8(86, 186, 154), .dark));
    } else {
        c.background = canvas.Color.rgb8(251, 251, 250); c.surface = canvas.Color.rgb8(255, 255, 255); c.surface_subtle = canvas.Color.rgb8(244, 245, 242);
        c.surface_pressed = canvas.Color.rgb8(225, 235, 229); c.text = canvas.Color.rgb8(30, 40, 37); c.text_muted = canvas.Color.rgb8(101, 112, 107);
        c.border = canvas.Color.rgb8(224, 229, 225); c.success = canvas.Color.rgb8(28, 138, 86); c.warning = canvas.Color.rgb8(184, 110, 0);
        c.destructive = canvas.Color.rgb8(201, 48, 44); c.info = canvas.Color.rgb8(98, 84, 214);
        t = t.withOverrides(canvas.accentOverrides(canvas.Color.rgb8(31, 91, 75), .light));
    }
    return t;
}
pub fn main(init: std.process.Init) !void {
    // Native file effects inherit the app's mask, including private request JSON.
    _ = std.c.umask(0o077);
    try std.Io.randomSecure(init.io, &intent_entropy);
    var exe_buf: [4096]u8 = undefined; const exe_len = try std.process.executablePath(init.io, &exe_buf); const exe_dir = std.fs.path.dirname(exe_buf[0..exe_len]).?;
    const root = init.environ_map.get("HARBOR_ROOT") orelse try std.fs.path.resolve(alloc, &.{ exe_dir, "../Resources/harbor" });
    node_path = init.environ_map.get("HARBOR_NODE") orelse try std.fs.path.resolve(alloc, &.{ exe_dir, "../Resources/runtime/node" });
    cli_path = try std.fs.path.join(alloc, &.{ root, "bin/harbor.mjs" }); gui_path = try std.fs.path.join(alloc, &.{ root, "scripts/gui.mjs" });
    home_directory = init.environ_map.get("HOME") orelse "";
    const state_home = init.environ_map.get("HARBOR_HOME") orelse try std.fs.path.join(alloc, &.{ init.environ_map.get("HOME") orelse ".", "Library/Application Support/Agent Harbor" });
    preferences_path = try std.fs.path.join(alloc, &.{ state_home, "ui-selection" });
    request_directory = try std.fs.path.join(alloc, &.{ state_home, "ui-requests" });
    _ = try std.Io.Dir.cwd().createDirPathStatus(init.io, request_directory, .fromMode(0o700));
    try std.Io.Dir.cwd().setFilePermissions(init.io, state_home, .fromMode(0o700), .{});
    try std.Io.Dir.cwd().setFilePermissions(init.io, request_directory, .fromMode(0o700), .{});
    const development = init.environ_map.get("HARBOR_ROOT") != null;
    if (!development) {
        const desktop_directory = try std.fs.path.join(alloc, &.{ state_home, "desktop" }); defer alloc.free(desktop_directory);
        _ = try std.Io.Dir.cwd().createDirPathStatus(init.io, desktop_directory, .fromMode(0o700));
        try std.Io.Dir.cwd().setFilePermissions(init.io, desktop_directory, .fromMode(0o700), .{});
        try std.process.setCurrentPath(init.io, desktop_directory);
    }
    const app = try HarborApp.create(alloc, .{ .name = "agent-harbor", .scene = scene, .canvas_label = label, .tokens_fn = tokens, .on_appearance = onAppearance, .on_chrome = onChrome, .on_command = onCommand, .init_fx = boot, .update_fx = update, .markup = .{ .source = app_markup, .watch_path = if (development) "src/app.native" else null, .io = init.io } });
    defer app.destroy(); defer app.model.deinit();
    try runner.runWithOptions(app.app(), .{ .app_name = "agent-harbor", .window_title = "Agent Harbor", .bundle_id = "dev.agentharbor.desktop", .default_frame = sdk.geometry.RectF.init(0, 0, 1380, 900), .restore_state = true, .js_window_api = false, .shortcuts = &shortcuts, .security = .{ .permissions = &permissions, .navigation = .{ .allowed_origins = &.{ "zero://inline", "zero://app" } } } }, init);
}
test { _ = @import("tests.zig"); }
