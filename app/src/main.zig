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
var intent_entropy: [32]u8 = @splat(0);
var intent_sequence: u64 = 0;
const label = "main-canvas";
const views = [_]sdk.ShellView{.{ .label = label, .kind = .gpu_surface, .fill = true, .role = "Session workspace", .accessibility_label = "Agent Harbor", .gpu_backend = .metal, .gpu_pixel_format = .bgra8_unorm, .gpu_present_mode = .timer, .gpu_alpha_mode = .@"opaque", .gpu_color_space = .srgb, .gpu_vsync = true }};
const windows = [_]sdk.ShellWindow{.{ .label = "main", .title = "Agent Harbor", .width = 1380, .height = 900, .restore_state = true, .views = &views }};
const scene: sdk.ShellConfig = .{ .windows = &windows };
const permissions = [_][]const u8{ sdk.security.permission_command, sdk.security.permission_view };

pub const Filter = enum { all, active, attention, stopped, archived };
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
    nativeSessionId: ?[]const u8 = null,
    runId: ?[]const u8 = null,
    pub fn providerName(s: *const Session) []const u8 { return if (eq(s.provider, "claude")) "Claude Code" else "Codex"; }
    pub fn statusName(s: *const Session) []const u8 {
        if (eq(s.status, "archived")) return "Archiviata";
        if (eq(s.status, "error")) return "Errore";
        if (!s.alive) return "Chiusa";
        if (eq(s.status, "attention")) return "Attenzione";
        if (eq(s.status, "starting")) return "Avvio";
        return if (s.pending or eq(s.status, "running")) "Al lavoro" else "Pronta";
    }
    pub fn ownerName(s: *const Session) []const u8 { return if (eq(s.owner, "human")) "Tu" else "Grok"; }
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
pub const Row = struct { id: []const u8, title: []const u8, meta: []const u8, status: []const u8, selected: bool, attention: bool };
pub const Msg = union(enum) {
    select: []const u8, filter_all, filter_active, filter_attention, filter_stopped, filter_archived,
    search_edit: canvas.TextInputEvent, new_session, cancel_form, create_session,
    title_edit: canvas.TextInputEvent, project_edit: canvas.TextInputEvent, prompt_edit: canvas.TextInputEvent,
    toggle_advanced, cli_args_edit: canvas.TextInputEvent,
    choose_codex, choose_claude, choose_folder, folder_done: sdk.EffectExit,
    take_control, release_control, start_session, stop_session, archive_session, restore_session,
    rename_session, rename_edit: canvas.TextInputEvent, save_name, cancel_name,
    reconnect, show_details, open_terminal, copy_id, previous_page, next_page,
    status_line: sdk.EffectLine, watch_done: sdk.EffectExit, command_done: sdk.EffectExit,
    tick: sdk.EffectTimer, terminal_event: sdk.EffectPtyEvent, terminal_state: canvas.TerminalState,
    prefs_loaded: sdk.EffectFileResult, prefs_saved: sdk.EffectFileResult, create_file_saved: sdk.EffectFileResult, copied: sdk.EffectClipboardResult,
    pub const view_unbound = .{ "status_line", "watch_done", "command_done", "tick", "terminal_event", "folder_done", "prefs_loaded", "prefs_saved", "create_file_saved", "copied" };
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
    action: enum { other, create, start, control, external } = .other,
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
    pub const view_unbound = .{ "snapshot", "pending_snapshot", "selection", "search_buffer", "title_buffer", "project_buffer", "prompt_buffer", "cli_args_buffer", "rename_buffer", "page", "watching", "connected", "notice_buffer", "action", "attached_id", "attached_run_id", "attached", "detaching", "attachment_human", "terminal_key", "cols", "rows", "first_output", "attach_wait", "operation_session", "create_id", "create_file_path", "create_payload_hash", "create_intent_valid", "pending", "filteredCount", "sessions", "deinit" };
    pub fn deinit(m: *Model) void { discardPending(m); if (m.snapshot) |p| p.deinit(); m.snapshot = null; }
    pub fn sessions(m: *const Model) []const Session { return if (m.snapshot) |p| p.value.sessions else &.{}; }
    pub fn selected(m: *const Model) ?Session { for (m.sessions()) |s| { if (eq(s.id, m.selection.text())) return s; } return null; }
    pub fn hasSelection(m: *const Model) bool { return m.selected() != null; }
    pub fn selectedTitle(m: *const Model) []const u8 { return if (m.selected()) |s| s.title else "Le tue sessioni, in un posto solo"; }
    pub fn selectedProvider(m: *const Model) []const u8 { return if (m.selected()) |s| s.providerName() else "Claude Code e Codex"; }
    pub fn selectedProject(m: *const Model) []const u8 { return if (m.selected()) |s| s.workingDirectory orelse s.project else ""; }
    pub fn selectedStatus(m: *const Model) []const u8 { return if (m.selected()) |s| s.statusName() else ""; }
    pub fn nativeId(m: *const Model) []const u8 { return if (m.selected()) |s| s.nativeSessionId orelse "In attesa del primo turno" else ""; }
    pub fn selectedId(m: *const Model) []const u8 { return m.selection.text(); }
    pub fn alive(m: *const Model) bool { return if (m.selected()) |s| s.alive else false; }
    pub fn human(m: *const Model) bool { return if (m.selected()) |s| eq(s.owner, "human") else false; }
    pub fn pending(m: *const Model) bool { return if (m.selected()) |s| s.pending else false; }
    pub fn archived(m: *const Model) bool { return if (m.selected()) |s| eq(s.status, "archived") else false; }
    pub fn attention(m: *const Model) bool { return if (m.selected()) |s| eq(s.status, "attention") or eq(s.status, "error") else false; }
    pub fn controlLabel(m: *const Model) []const u8 { return if (m.human()) "Hai il controllo" else "Controllo a Grok"; }
    pub fn controlHint(m: *const Model) []const u8 {
        if (m.human() and m.pending()) return "Concludi la richiesta nel terminale prima di passare il controllo o chiudere la CLI.";
        return if (m.human()) "Scrivi direttamente nel terminale. Grok attende." else "Stai osservando. Prendi il controllo per intervenire.";
    }
    pub fn attentionHint(m: *const Model) []const u8 {
        return if (m.human()) "Verifica la richiesta nel terminale. Nessuna autorizzazione viene confermata automaticamente." else "L'agente richiede attenzione. Prendi il controllo e verifica il terminale; nessuna autorizzazione viene confermata automaticamente.";
    }
    pub fn cannotRelease(m: *const Model) bool { return m.busy or m.pending() or !m.human(); }
    pub fn cannotStop(m: *const Model) bool { return m.busy or m.pending() or !m.alive() or !m.human(); }
    pub fn canStart(m: *const Model) bool { return !m.alive() and !m.archived(); }
    pub fn cannotStart(m: *const Model) bool { return m.busy or !m.human(); }
    pub fn notice(m: *const Model) []const u8 { return m.notice_buffer.text(); }
    pub fn connection(m: *const Model) []const u8 { return if (m.connected) "Gestore connesso" else "Connessione al gestore..."; }
    pub fn searchText(m: *const Model) []const u8 { return m.search_buffer.text(); }
    pub fn formTitle(m: *const Model) []const u8 { return m.title_buffer.text(); }
    pub fn formProject(m: *const Model) []const u8 { return m.project_buffer.text(); }
    pub fn formPrompt(m: *const Model) []const u8 { return m.prompt_buffer.text(); }
    pub fn formCliArgs(m: *const Model) []const u8 { return m.cli_args_buffer.text(); }
    pub fn renameText(m: *const Model) []const u8 { return m.rename_buffer.text(); }
    pub fn cannotCreate(m: *const Model) bool { return m.busy or m.project_buffer.isEmpty() or m.title_buffer.isEmpty() or m.formHasTruncation(); }
    pub fn formHasTruncation(m: *const Model) bool { return m.project_buffer.truncated or m.title_buffer.truncated or m.prompt_buffer.truncated or m.cli_args_buffer.truncated; }
    pub fn allCount(m: *const Model) usize { var n: usize = 0; for (m.sessions()) |s| { if (!eq(s.status,"archived")) n += 1; } return n; }
    pub fn activeCount(m: *const Model) usize { var n: usize = 0; for (m.sessions()) |s| { if (s.alive) n += 1; } return n; }
    pub fn attentionCount(m: *const Model) usize { var n: usize = 0; for (m.sessions()) |s| { if (eq(s.status,"attention") or eq(s.status,"error")) n += 1; } return n; }
    pub fn matches(m: *const Model, s: Session) bool {
        const included = switch (m.filter) { .all => !eq(s.status,"archived"), .active => s.alive, .attention => eq(s.status,"attention") or eq(s.status,"error"), .stopped => !s.alive and !eq(s.status,"archived"), .archived => eq(s.status,"archived") };
        const q = std.mem.trim(u8,m.search_buffer.text()," \t");
        return included and (q.len == 0 or contains(s.title,q) or contains(s.project,q) or contains(s.provider,q));
    }
    pub fn filteredCount(m: *const Model) usize { var n: usize = 0; for (m.sessions()) |s| { if (m.matches(s)) n += 1; } return n; }
    pub fn visible(m: *const Model, arena: std.mem.Allocator) []const Row {
        const out = arena.alloc(Row, 20) catch return &.{};
        var seen: usize = 0; var count: usize = 0;
        for (m.sessions()) |s| {
            if (!m.matches(s)) continue;
            seen += 1; if (seen <= m.page*20) continue;
            if (count == out.len) break;
            out[count] = .{ .id=s.id,.title=s.title,.status=s.statusName(),.selected=eq(s.id,m.selection.text()),.attention=eq(s.status,"attention") or eq(s.status,"error"),.meta=std.fmt.allocPrint(arena,"{s} · {s} · {s}",.{s.providerName(),s.ownerName(),std.fs.path.basename(s.project)}) catch "" }; count += 1;
        }
        return out[0..count];
    }
    pub fn pageLabel(m: *const Model, arena: std.mem.Allocator) []const u8 { return std.fmt.allocPrint(arena,"{d} sessioni · pagina {d}/{d}",.{m.filteredCount(),m.page+1,@max(1,(m.filteredCount()+19)/20)}) catch ""; }
    pub fn firstPage(m: *const Model) bool { return m.page == 0; }
    pub fn lastPage(m: *const Model) bool { return (m.page+1)*20 >= m.filteredCount(); }
    pub fn ptyKey(m: *const Model) u64 { return m.terminal_key; }
    pub fn terminalVisible(m: *const Model) bool { return m.alive() and !m.creating; }
};
pub const Effects = sdk.Effects(Msg);
pub const AppUi = canvas.Ui(Msg);
pub const app_markup = @embedFile("app.native");
const HarborApp = sdk.UiApp(Model,Msg);
fn eq(a: []const u8,b: []const u8) bool { return std.mem.eql(u8,a,b); }
fn contains(a: []const u8,b: []const u8) bool { if (b.len>a.len) return false; for (0..a.len-b.len+1) |i| { if (std.ascii.eqlIgnoreCase(a[i..i+b.len],b)) return true; } return false; }
fn notice(m: *Model, text: []const u8) void { m.notice_buffer.set(text); }
fn clearCreateIntent(m: *Model) void { m.create_id.clear(); m.create_file_path.clear(); m.create_intent_valid=false; }
fn createIntent(m: *Model, args_json: []const u8, prompt: []const u8) void {
    var payload=std.crypto.hash.sha2.Sha256.init(.{});
    for ([_][]const u8{if(m.form_claude)"claude" else "codex",m.formProject(),m.formTitle(),prompt,args_json}) |part| {
        var len:[8]u8=undefined;std.mem.writeInt(u64,&len,@intCast(part.len),.little);
        payload.update(&len);payload.update(part);
    }
    const digest=payload.finalResult();
    if (m.create_intent_valid and std.mem.eql(u8,&m.create_payload_hash,&digest)) return;
    intent_sequence+=1;
    var sequence:[8]u8=undefined;std.mem.writeInt(u64,&sequence,intent_sequence,.little);
    var unique=std.crypto.hash.sha2.Sha256.init(.{});unique.update(&intent_entropy);unique.update(&sequence);
    var bytes=unique.finalResult();bytes[6]=(bytes[6]&0x0f)|0x40;bytes[8]=(bytes[8]&0x3f)|0x80;
    const hex="0123456789abcdef";
    var uuid:[36]u8=undefined;var out:usize=0;
    for(bytes[0..16],0..)|byte,i| {
        if(i==4 or i==6 or i==8 or i==10){uuid[out]='-';out+=1;}
        uuid[out]=hex[byte>>4];uuid[out+1]=hex[byte&0x0f];out+=2;
    }
    m.create_id.set(&uuid);m.create_payload_hash=digest;m.create_intent_valid=true;
}
fn run(m: *Model,fx: *Effects,args: []const []const u8) void {
    if (m.busy) return;
    var bytes=node_path.len+cli_path.len;for(args)|arg|bytes+=arg.len;
    if(args.len+2>sdk.max_effect_argv or bytes>sdk.max_effect_argv_bytes){notice(m,"I percorsi dell'app superano il limite del terminale. Usa una posizione più breve.");return;}
    m.busy=true; m.operation_session.set(m.selectedId());
    var argv: [20][]const u8 = undefined; argv[0]=node_path; argv[1]=cli_path;
    for (args,0..) |arg,i| argv[i+2]=arg;
    fx.spawn(.{.key=101,.argv=argv[0..args.len+2],.output=.collect,.on_exit=Effects.exitMsg(.command_done)});
}
fn writeCreateRequest(m: *Model, fx: *Effects, cli_args: []const []const u8, prompt: []const u8) void {
    const path=std.fmt.allocPrint(alloc,"{s}/{s}.json",.{request_directory,m.create_id.text()}) catch {notice(m,"Impossibile preparare la richiesta.");return;};
    defer alloc.free(path);
    m.create_file_path.set(path);
    if(m.create_file_path.truncated){notice(m,"Il percorso dei dati dell'app è troppo lungo.");return;}
    var json:std.Io.Writer.Allocating=.init(alloc);defer json.deinit();
    std.json.Stringify.value(.{.id=m.create_id.text(),.requestId=m.create_id.text(),.provider=if(m.form_claude)"claude" else "codex",.project=m.formProject(),.title=m.formTitle(),.owner="human",.text=prompt,.cliArgs=cli_args},.{},&json.writer) catch {notice(m,"Impossibile preparare la richiesta.");return;};
    m.busy=true;
    fx.writeFile(.{.key=108,.path=m.create_file_path.text(),.bytes=json.written(),.on_result=Effects.fileMsg(.create_file_saved)});
}
fn watch(m: *Model,fx: *Effects) void {
    if (m.watching) return; m.watching=true;
    fx.spawn(.{.key=100,.argv=&.{node_path,cli_path,"watch","--compact","--include-archived","--chunked"},.max_line_bytes=max_snapshot_line_bytes,.on_line=Effects.lineMsg(.status_line),.on_exit=Effects.exitMsg(.watch_done)});
}
fn saveSelection(m: *Model,fx: *Effects) void {
    if (preferences_path.len>0) fx.writeFile(.{.key=104,.path=preferences_path,.bytes=m.selection.text(),.on_result=Effects.fileMsg(.prefs_saved)});
}
fn syncTerminal(m: *Model,fx: *Effects) void {
    const wants = m.alive() and !m.creating;
    const run_id = if (m.selected()) |s| s.runId orelse "" else "";
    if (m.attached and (!wants or !eq(m.attached_id.text(),m.selection.text()) or !eq(m.attached_run_id.text(),run_id) or m.attachment_human != m.human())) {
        if (!m.detaching) { m.detaching=true; fx.ptyKill(m.terminal_key); }
        return;
    }
    if (m.attached or m.detaching or m.attach_wait or !wants or m.cols==0 or m.rows==0) return;
    // Native SDK retains one emulator per key (four total). Reuse the visible
    // terminal's key after exit: its first output resets the ended emulator;
    // the effect engine rejects stale output using its internal generation.
    m.attached=true; m.attached_id.set(m.selection.text()); m.attached_run_id.set(run_id); m.attachment_human=m.human(); m.first_output=true;
    fx.ptySpawn(.{.key=m.terminal_key,.argv=&.{node_path,cli_path,"attach",m.selection.text()},.cols=m.cols,.rows=m.rows,.term="xterm-256color",.on_event=Effects.ptyMsg(.terminal_event)});
}
fn discardPending(m: *Model) void {
    if (m.pending_snapshot) |*pending| pending.deinit();
    m.pending_snapshot = null;
}
fn rejectSnapshot(m: *Model, fx: *Effects) void {
    discardPending(m);
    m.connected = false;
    notice(m,"Aggiornamento incompleto. Lo stato precedente resta visibile; riconnessione automatica.");
    // A watch sends only changed state. Restart it to recover a dropped chunk even
    // when the broker's sessions have not changed in the meantime.
    if (m.watching) fx.cancel(100);
}
fn snapshot(m: *Model,fx: *Effects,bytes: []const u8) void {
    if (bytes.len > max_snapshot_line_bytes) { rejectSnapshot(m,fx); return; }
    const parsed = std.json.parseFromSlice(SnapshotHeader,alloc,bytes,.{.ignore_unknown_fields=true,.allocate=.alloc_always}) catch { rejectSnapshot(m,fx); return; };
    defer parsed.deinit();
    const frame = parsed.value;
    if (frame.snapshotId.len == 0 or frame.snapshotId.len > 128) { rejectSnapshot(m,fx); return; }
    if (eq(frame.type,"snapshot-begin")) {
        const count = frame.count orelse { rejectSnapshot(m,fx); return; };
        if (count > max_snapshot_bytes) { rejectSnapshot(m,fx); return; }
        discardPending(m);
        m.pending_snapshot = PendingSnapshot.init(frame.snapshotId,count,bytes.len+1) catch { rejectSnapshot(m,fx); return; };
        return;
    }
    const pending = if (m.pending_snapshot) |*p| p else { rejectSnapshot(m,fx); return; };
    if (!eq(frame.snapshotId,pending.id) or bytes.len+1 > max_snapshot_bytes - pending.bytes) { rejectSnapshot(m,fx); return; }
    pending.bytes += bytes.len+1;
    if (eq(frame.type,"snapshot-chunk")) {
        const chunk = std.json.parseFromSliceLeaky(Snapshot,pending.arena.allocator(),bytes,.{.ignore_unknown_fields=true,.allocate=.alloc_always}) catch { rejectSnapshot(m,fx); return; };
        if (chunk.sessions.len > pending.expected_count - pending.sessions.items.len) { rejectSnapshot(m,fx); return; }
        pending.sessions.appendSlice(pending.arena.allocator(),chunk.sessions) catch { rejectSnapshot(m,fx); return; };
        return;
    }
    if (!eq(frame.type,"snapshot-end") or pending.sessions.items.len != pending.expected_count) { rejectSnapshot(m,fx); return; }
    const sessions = pending.sessions.toOwnedSlice(pending.arena.allocator()) catch { rejectSnapshot(m,fx); return; };
    const complete: std.json.Parsed(Snapshot) = .{ .arena=pending.arena, .value=.{.sessions=sessions} };
    m.pending_snapshot = null; // Ownership of all chunk strings moves with the arena.
    if (m.snapshot) |old| old.deinit(); m.snapshot=complete; m.connected=true;
    if (!m.hasSelection() and m.sessions().len>0) { m.selection.set(m.sessions()[0].id); saveSelection(m,fx); }
    if (m.page*20>=m.filteredCount()) m.page=0;
    syncTerminal(m,fx);
}
fn boot(m: *Model,fx: *Effects) void {
    notice(m,"Chiudere questa finestra lascia lavorare le sessioni.");
    if (preferences_path.len>0) fx.readFile(.{.key=103,.path=preferences_path,.on_result=Effects.fileMsg(.prefs_loaded)});
    watch(m,fx);
    fx.startTimer(.{.key=1,.interval_ms=3000,.mode=.repeating,.on_fire=Effects.timerMsg(.tick)});
}
fn select(m: *Model,fx: *Effects,id: []const u8) void { m.selection.set(id);m.creating=false;m.renaming=false;m.scrollback=0;saveSelection(m,fx);syncTerminal(m,fx); }
pub fn update(m: *Model,msg: Msg,fx: *Effects) void {
    switch(msg) {
        .select=>|id|select(m,fx,id),
        .filter_all,.filter_active,.filter_attention,.filter_stopped,.filter_archived=>{m.filter=switch(msg){.filter_active=>.active,.filter_attention=>.attention,.filter_stopped=>.stopped,.filter_archived=>.archived,else=>.all};m.page=0;},
        .search_edit=>|e|{m.search_buffer.apply(e);m.page=0;},
        .previous_page=>{if(m.page>0)m.page-=1;},.next_page=>{if(!m.lastPage())m.page+=1;},
        .new_session=>{if(m.busy)return;m.creating=true;m.renaming=false;m.advanced=false;clearCreateIntent(m);m.title_buffer.clear();m.prompt_buffer.clear();m.cli_args_buffer.clear();if(m.selected())|s|m.project_buffer.set(s.project);syncTerminal(m,fx);},
        .cancel_form=>{if(m.busy)return;m.creating=false;clearCreateIntent(m);syncTerminal(m,fx);},
        .title_edit=>|e|m.title_buffer.apply(e),.project_edit=>|e|m.project_buffer.apply(e),.prompt_edit=>|e|m.prompt_buffer.apply(e),
        .cli_args_edit=>|e|m.cli_args_buffer.apply(e),.toggle_advanced=>m.advanced=!m.advanced,
        .choose_codex=>m.form_claude=false,.choose_claude=>m.form_claude=true,
        .choose_folder=>{fx.spawn(.{.key=105,.argv=&.{node_path,gui_path,"folder"},.output=.collect,.on_exit=Effects.exitMsg(.folder_done)});},
        .folder_done=>|r|{if(r.code==0 and r.reason==.exited){const p=std.mem.trim(u8,r.output,"\r\n");if(p.len>0)m.project_buffer.set(p);}else notice(m,"Selezione cartella annullata o non disponibile.");},
        .create_session=>{
            if(m.cannotCreate())return;
            const cli_args=std.mem.trim(u8,m.formCliArgs()," \t\r\n");
            const args_json=if(cli_args.len==0)"[]" else cli_args;
            const checked=std.json.parseFromSlice([]const []const u8,alloc,args_json,.{}) catch {notice(m,"Le opzioni devono essere un array JSON di stringhe, per esempio [\"--model\",\"nome-modello\"].");return;};
            defer checked.deinit();
            const prompt=if(m.prompt_buffer.isEmpty())"Rispondi soltanto PRONTO. Non usare strumenti e non modificare file." else m.formPrompt();
            createIntent(m,args_json,prompt);
            m.action=.create;notice(m,"Creazione della sessione...");
            writeCreateRequest(m,fx,checked.value,prompt);
        },
        .create_file_saved=>|r|{m.busy=false;if(r.outcome==.ok){run(m,fx,&.{"create","--request-file",m.create_file_path.text()});}else notice(m,"La richiesta non è stata salvata. Riprova per continuare la stessa creazione.");},
        .take_control,.release_control=>{if(!m.hasSelection() or m.busy or (std.meta.activeTag(msg)==.release_control and m.cannotRelease()))return;m.action=.control;run(m,fx,&.{"control",m.selectedId(),if(std.meta.activeTag(msg)==.take_control)"human" else "grok"});},
        .start_session=>{if(m.cannotStart())return;m.action=.start;run(m,fx,&.{"start",m.selectedId(),"--actor","human"});},
        .stop_session=>{if(m.cannotStop())return;m.action=.other;notice(m,"Chiusura della CLI. La conversazione rimane salvata.");run(m,fx,&.{"stop",m.selectedId(),"--actor","human"});},
        .archive_session=>{if(m.alive() or m.busy)return;m.action=.other;run(m,fx,&.{"archive",m.selectedId()});},
        .restore_session=>{m.action=.other;run(m,fx,&.{"restore",m.selectedId()});},
        .rename_session=>{if(m.selected())|s|{m.rename_buffer.set(s.title);m.renaming=true;}},.rename_edit=>|e|m.rename_buffer.apply(e),
        .save_name=>{if(m.rename_buffer.isEmpty() or m.rename_buffer.truncated)return;m.action=.other;run(m,fx,&.{"rename",m.selectedId(),"--title",m.renameText()});},.cancel_name=>m.renaming=false,
        .show_details=>m.details=!m.details,
        .reconnect=>{if(m.attached and !m.detaching){m.detaching=true;fx.ptyKill(m.terminal_key);}else syncTerminal(m,fx);},
        .open_terminal=>{if(!m.hasSelection() or m.busy)return;m.action=.external;run(m,fx,&.{"control",m.selectedId(),"human"});},
        .copy_id=>fx.writeClipboard(.{.key=106,.text=m.nativeId(),.on_result=Effects.clipboardMsg(.copied)}),
        .copied=>|r|{notice(m,if(r.outcome==.ok)"Identificativo copiato." else "Impossibile copiare l'identificativo.");},
        .status_line=>|line|{if(line.truncated or line.dropped_before>0){rejectSnapshot(m,fx);}else snapshot(m,fx,line.line);},
        .watch_done=>|r|{discardPending(m);m.watching=false;m.connected=false;if(r.reason!=.cancelled)notice(m,"Gestore scollegato. Riconnessione automatica; le CLI restano attive.");},
        .tick=>|t|{if(t.outcome==.fired){m.attach_wait=false;watch(m,fx);syncTerminal(m,fx);}},
        .command_done=>|r|{
            m.busy=false;
            if(r.reason!=.exited or r.code!=0 or r.output_truncated){
                const failure=std.json.parseFromSlice(struct { @"error": struct { message: []const u8 } },alloc,r.output,.{.ignore_unknown_fields=true}) catch null;
                if(failure)|f|{defer f.deinit();notice(m,f.value.@"error".message);}else notice(m,if(r.stderr_tail.len>0)r.stderr_tail else "Operazione non completata. Verifica il terminale prima di riprovare.");return;
            }
            const parsed=std.json.parseFromSlice(struct { session: ?Session = null },alloc,r.output,.{.ignore_unknown_fields=true}) catch null;
            if(parsed)|p|{defer p.deinit();if(m.action==.create){const created=p.value.session orelse {notice(m,"Risposta incompleta. Riprova per verificare la stessa creazione.");return;};m.creating=false;clearCreateIntent(m);m.title_buffer.clear();m.prompt_buffer.clear();m.cli_args_buffer.clear();select(m,fx,created.id);}}
            else if(m.action==.create){notice(m,"Risposta incompleta. Riprova per verificare la stessa creazione.");return;}
            m.renaming=false;
            if(m.action==.external){fx.spawn(.{.key=107,.argv=&.{node_path,gui_path,"terminal",m.operation_session.text()},.output=.collect,.on_exit=Effects.exitMsg(.folder_done)});}
            notice(m,if(m.action==.control)"Controllo aggiornato. Il terminale si ricollega." else "Operazione completata.");
        },
        .terminal_state=>|s|{m.cols=s.cols;m.rows=s.rows;m.scrollback=s.scrollback;if(m.attached)fx.ptyResize(m.terminal_key,s.cols,s.rows);syncTerminal(m,fx);},
        .terminal_event=>|e|{
            if(e.key!=m.terminal_key)return;
            if(e.kind==.output){if(m.first_output){fx.ptyResize(e.key,m.cols,m.rows);m.first_output=false;}return;}
            if(e.kind==.exit){const wanted=m.detaching;m.attached=false;m.detaching=false;m.attach_wait=!wanted;if(wanted)syncTerminal(m,fx);}
        },
        .prefs_loaded=>|r|{if(r.outcome==.ok and r.bytes.len<=64){m.selection.set(std.mem.trim(u8,r.bytes,"\r\n"));syncTerminal(m,fx);}},
        .prefs_saved=>|r|{if(r.outcome!=.ok)notice(m,"La selezione non è stata salvata. Le sessioni restano nel gestore.");},
    }
}
fn theme() canvas.DesignTokens { var t:canvas.DesignTokens=.{};t.colors.background=canvas.Color.rgb8(248,249,247);t.colors.surface=canvas.Color.rgb8(255,255,253);t.colors.surface_subtle=canvas.Color.rgb8(238,241,237);t.colors.surface_pressed=canvas.Color.rgb8(221,234,225);t.colors.accent=canvas.Color.rgb8(31,91,75);t.colors.accent_text=canvas.Color.rgb8(255,255,255);t.colors.text=canvas.Color.rgb8(34,47,43);t.colors.text_muted=canvas.Color.rgb8(98,111,105);t.colors.border=canvas.Color.rgb8(220,226,220);t.typography.heading_size=24;return t; }
pub fn main(init: std.process.Init) !void {
    // Native file effects inherit the app's mask, including private request JSON.
    _ = std.c.umask(0o077);
    try std.Io.randomSecure(init.io,&intent_entropy);
    var exe_buf:[4096]u8=undefined;const exe_len=try std.process.executablePath(init.io,&exe_buf);const exe_dir=std.fs.path.dirname(exe_buf[0..exe_len]).?;
    const root=init.environ_map.get("HARBOR_ROOT") orelse try std.fs.path.resolve(alloc,&.{exe_dir,"../Resources/harbor"});
    node_path=init.environ_map.get("HARBOR_NODE") orelse try std.fs.path.resolve(alloc,&.{exe_dir,"../Resources/runtime/node"});
    cli_path=try std.fs.path.join(alloc,&.{root,"bin/harbor.mjs"});gui_path=try std.fs.path.join(alloc,&.{root,"scripts/gui.mjs"});
    const state_home=init.environ_map.get("HARBOR_HOME") orelse try std.fs.path.join(alloc,&.{init.environ_map.get("HOME") orelse ".","Library/Application Support/Agent Harbor"});
    preferences_path=try std.fs.path.join(alloc,&.{state_home,"ui-selection"});
    request_directory=try std.fs.path.join(alloc,&.{state_home,"ui-requests"});
    _ = try std.Io.Dir.cwd().createDirPathStatus(init.io,request_directory,.fromMode(0o700));
    try std.Io.Dir.cwd().setFilePermissions(init.io,state_home,.fromMode(0o700),.{});
    try std.Io.Dir.cwd().setFilePermissions(init.io,request_directory,.fromMode(0o700),.{});
    const development=init.environ_map.get("HARBOR_ROOT")!=null;
    if(!development){
        const desktop_directory=try std.fs.path.join(alloc,&.{state_home,"desktop"});defer alloc.free(desktop_directory);
        _ = try std.Io.Dir.cwd().createDirPathStatus(init.io,desktop_directory,.fromMode(0o700));
        try std.Io.Dir.cwd().setFilePermissions(init.io,desktop_directory,.fromMode(0o700),.{});
        try std.process.setCurrentPath(init.io,desktop_directory);
    }
    const app=try HarborApp.create(alloc,.{.name="agent-harbor",.scene=scene,.canvas_label=label,.tokens=theme(),.init_fx=boot,.update_fx=update,.markup=.{.source=app_markup,.watch_path=if(development)"src/app.native" else null,.io=init.io}});
    defer app.destroy();defer app.model.deinit();
    try runner.runWithOptions(app.app(),.{.app_name="agent-harbor",.window_title="Agent Harbor",.bundle_id="dev.agentharbor.desktop",.default_frame=sdk.geometry.RectF.init(0,0,1380,900),.restore_state=true,.js_window_api=false,.security=.{.permissions=&permissions,.navigation=.{.allowed_origins=&.{"zero://inline","zero://app"}}}},init);
}
test { _ = @import("tests.zig"); }
