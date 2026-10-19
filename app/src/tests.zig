const std = @import("std");
const main = @import("main.zig");
const sdk = @import("native_sdk");
const canvas = sdk.canvas;

fn frame(model: *main.Model, fx: *main.Effects, value: anytype) !void {
    var json:std.Io.Writer.Allocating=.init(std.testing.allocator);defer json.deinit();
    try std.json.Stringify.value(value,.{},&json.writer);
    main.update(model,.{.status_line=.{.key=100,.line=json.written()}},fx);
}
fn begin(model: *main.Model, fx: *main.Effects, id: []const u8, count: usize) !void {
    try frame(model,fx,.{.type="snapshot-begin",.snapshotId=id,.count=count});
}
fn chunk(model: *main.Model, fx: *main.Effects, id: []const u8, sessions: []const main.Session) !void {
    try frame(model,fx,.{.type="snapshot-chunk",.snapshotId=id,.sessions=sessions});
}
fn end(model: *main.Model, fx: *main.Effects, id: []const u8) !void {
    try frame(model,fx,.{.type="snapshot-end",.snapshotId=id});
}
fn loadSnapshot(model: *main.Model, fx: *main.Effects, bytes: []const u8) !void {
    const parsed=try std.json.parseFromSlice(struct {sessions: []const main.Session},std.testing.allocator,bytes,.{});
    defer parsed.deinit();
    try begin(model,fx,"fixture",parsed.value.sessions.len);
    try chunk(model,fx,"fixture",parsed.value.sessions);
    try end(model,fx,"fixture");
}

test "1000 metadata records commit atomically across bounded chunks and preserve selection" {
    var model:main.Model=.{};defer model.deinit();
    var fx=main.Effects.init(std.testing.allocator);defer fx.deinit();fx.executor=.fake;
    try loadSnapshot(&model,&fx,"{\"sessions\":[{\"id\":\"session-31\",\"title\":\"Previous state\"}]}");
    var sessions: [1000]main.Session=undefined;
    var ids:[1000][16]u8=undefined;
    for(&sessions,0..)|*s,i| {
        const id=try std.fmt.bufPrint(&ids[i],"session-{d}",.{i});
        s.*=.{.id=id,.title="Metadata review " ** 8,.provider=if(i%2==0)"codex" else "claude",.project="/fixture/workspace/a-long-project-directory",.owner=if(i%2==0)"human" else "grok",.runId=id};
    }
    try begin(&model,&fx,"large",sessions.len);
    var total_bytes:usize=0;
    var offset:usize=0;
    while(offset<sessions.len) : (offset+=100) {
        var json:std.Io.Writer.Allocating=.init(std.testing.allocator);defer json.deinit();
        try std.json.Stringify.value(.{.type="snapshot-chunk",.snapshotId="large",.sessions=sessions[offset..@min(offset+100,sessions.len)]},.{},&json.writer);
        try std.testing.expect(json.written().len<main.max_snapshot_line_bytes);
        total_bytes+=json.written().len;
        main.update(&model,.{.status_line=.{.key=100,.line=json.written()}},&fx);
        try std.testing.expectEqual(@as(usize,1),model.allCount());
        try std.testing.expectEqualStrings("Previous state",model.selectedTitle());
    }
    try std.testing.expect(total_bytes>main.max_snapshot_line_bytes);
    try end(&model,&fx,"large");
    try std.testing.expectEqual(@as(usize,1000),model.allCount());
    try std.testing.expectEqualStrings("session-31",model.selectedId());
    try std.testing.expectEqualStrings("claude",model.selected().?.provider);
    try std.testing.expect(model.connected);
    try std.testing.expect(model.pending_snapshot==null);
    var arena=std.heap.ArenaAllocator.init(std.testing.allocator);defer arena.deinit();
    model.page=49;
    const page=sessionRows(&model,arena.allocator());
    try std.testing.expectEqualStrings("session-980",page[0].id);
    try std.testing.expectEqual(@as(usize,20),page.len);
}

test "mismatched incomplete dropped and corrupt snapshots preserve committed state" {
    var model:main.Model=.{};defer model.deinit();
    var fx=main.Effects.init(std.testing.allocator);defer fx.deinit();fx.executor=.fake;
    try loadSnapshot(&model,&fx,"{\"sessions\":[{\"id\":\"original\",\"title\":\"Keep me\"}]}");
    for(0..9)|case| {
        try begin(&model,&fx,"pending",2);
        try chunk(&model,&fx,"pending",&.{.{.id="new"}});
        switch(case) {
            0=>try chunk(&model,&fx,"different",&.{.{.id="second"}}),
            1=>try end(&model,&fx,"different"),
            2=>try end(&model,&fx,"pending"),
            3=>try chunk(&model,&fx,"pending",&.{.{.id="second"},.{.id="third"}}),
            4=>main.update(&model,.{.status_line=.{.key=100,.line="{}",.truncated=true}},&fx),
            5=>main.update(&model,.{.status_line=.{.key=100,.line="{}",.dropped_before=1}},&fx),
            6=>main.update(&model,.{.watch_done=.{.key=100,.code=1,.reason=.exited}},&fx),
            7=>main.update(&model,.{.status_line=.{.key=100,.line="{broken"}},&fx),
            else=>try frame(&model,&fx,.{.type="unexpected",.snapshotId="pending"}),
        }
        try std.testing.expectEqualStrings("Keep me",model.selectedTitle());
        try std.testing.expectEqual(@as(usize,1),model.allCount());
        try std.testing.expect(model.pending_snapshot==null);
        try std.testing.expect(!model.connected);
        // A late end cannot complete a discarded assembly.
        try end(&model,&fx,"pending");
        try std.testing.expectEqualStrings("Keep me",model.selectedTitle());
    }
    try begin(&model,&fx,"empty",0);
    try end(&model,&fx,"empty");
    try std.testing.expectEqual(@as(usize,0),model.allCount());
    try std.testing.expect(model.connected);
}

test "snapshot line and aggregate byte limits reject before replacing state" {
    var model:main.Model=.{};defer model.deinit();
    var fx=main.Effects.init(std.testing.allocator);defer fx.deinit();fx.executor=.fake;
    try loadSnapshot(&model,&fx,"{\"sessions\":[{\"id\":\"original\"}]}");
    const oversized=try std.testing.allocator.alloc(u8,main.max_snapshot_line_bytes+1);defer std.testing.allocator.free(oversized);
    @memset(oversized,' ');
    try begin(&model,&fx,"oversized",0);
    main.update(&model,.{.status_line=.{.key=100,.line=oversized}},&fx);
    try std.testing.expect(model.pending_snapshot==null);
    try std.testing.expectEqualStrings("original",model.selectedId());
    // Empty chunks with large ignored metadata exercise the wire-byte budget
    // without depending on model size or a large number of sessions.
    const padding=try std.testing.allocator.alloc(u8,main.max_snapshot_line_bytes-1024);defer std.testing.allocator.free(padding);
    @memset(padding,'x');
    var json:std.Io.Writer.Allocating=.init(std.testing.allocator);defer json.deinit();
    try std.json.Stringify.value(.{.type="snapshot-chunk",.snapshotId="aggregate",.sessions=[_]main.Session{},.metadata=padding},.{},&json.writer);
    try begin(&model,&fx,"aggregate",0);
    const lines=main.max_snapshot_bytes/json.written().len;
    for(0..lines)|_| main.update(&model,.{.status_line=.{.key=100,.line=json.written()}},&fx);
    try std.testing.expect(model.pending_snapshot!=null);
    main.update(&model,.{.status_line=.{.key=100,.line=json.written()}},&fx);
    try std.testing.expect(model.pending_snapshot==null);
    try std.testing.expectEqualStrings("original",model.selectedId());
    try std.testing.expect(!model.connected);
}

test "new begin can recover interrupted data and watch requests chunking" {
    var model:main.Model=.{};defer model.deinit();
    var fx=main.Effects.init(std.testing.allocator);defer fx.deinit();fx.executor=.fake;
    try loadSnapshot(&model,&fx,"{\"sessions\":[{\"id\":\"original\"}]}");
    try begin(&model,&fx,"abandoned",2);
    try chunk(&model,&fx,"abandoned",&.{.{.id="unused"}});
    try begin(&model,&fx,"replacement",1);
    try chunk(&model,&fx,"replacement",&.{.{.id="replacement"}});
    try std.testing.expectEqualStrings("original",model.selectedId());
    try end(&model,&fx,"replacement");
    try std.testing.expectEqualStrings("replacement",model.selectedId());
    main.update(&model,.{.tick=.{.key=1,.outcome=.fired}},&fx);
    const request=fx.pendingSpawnAt(0).?;
    try std.testing.expectEqualStrings("--chunked",request.argv[request.argv.len-1]);
    try std.testing.expectEqual(@as(usize,main.max_snapshot_line_bytes),request.max_line_bytes);
    main.update(&model,.{.status_line=.{.key=100,.line="{}",.dropped_before=1}},&fx);
    try std.testing.expectEqual(@as(usize,0),fx.pendingSpawnCount());
    try std.testing.expectEqualStrings("replacement",model.selectedId());
}

test "same session resumed with a new run or owner retires the old attachment" {
    var model:main.Model=.{};defer model.deinit();
    var fx=main.Effects.init(std.testing.allocator);defer fx.deinit();fx.executor=.fake;
    try loadSnapshot(&model,&fx,"{\"sessions\":[{\"id\":\"one\",\"alive\":true,\"runId\":\"run-1\",\"owner\":\"human\"}]}");
    main.update(&model,.{.terminal_state=.{.cols=100,.rows=30,.scrollback=0,.history=0}},&fx);
    const first=model.terminal_key;
    try loadSnapshot(&model,&fx,"{\"sessions\":[{\"id\":\"one\",\"alive\":true,\"runId\":\"run-2\",\"owner\":\"human\"}]}");
    try std.testing.expect(model.detaching);
    try std.testing.expectEqual(first,model.terminal_key);
    completeEffect(&model,&fx,.{.terminal_event=.{.key=first,.kind=.exit}});
    try std.testing.expect(model.attached and !model.detaching);
    try std.testing.expectEqualStrings("run-2",model.attached_run_id.text());
    try std.testing.expectEqual(first,model.terminal_key);
    const second=model.terminal_key;
    try loadSnapshot(&model,&fx,"{\"sessions\":[{\"id\":\"one\",\"alive\":true,\"runId\":\"run-2\",\"owner\":\"grok\"}]}");
    try std.testing.expect(model.detaching);
    completeEffect(&model,&fx,.{.terminal_event=.{.key=second,.kind=.exit}});
    try std.testing.expect(!model.attachment_human);
    try std.testing.expect(model.attached);
}

test "advanced CLI arguments stay literal and invalid JSON cannot start a process" {
    var model:main.Model=.{};defer model.deinit();
    var fx=main.Effects.init(std.testing.allocator);defer fx.deinit();fx.executor=.fake;
    main.update(&model,.new_session,&fx);
    model.title_buffer.set("Review");model.project_buffer.set("/fixture/workspace");
    for([_] []const u8{"--model example","[1]","{\"model\":\"example\"}"})|invalid| {
        model.cli_args_buffer.set(invalid);
        main.update(&model,.create_session,&fx);
        try std.testing.expect(!model.busy);
        try std.testing.expectEqual(@as(usize,0),fx.pendingSpawnCount());
    }
    const args="[\"--model\",\"example\",\"--add-dir\",\"/fixture/a b; $(unchanged)\"]";
    model.cli_args_buffer.set(args);
    model.prompt_buffer.set("p" ** 4096);
    main.update(&model,.create_session,&fx);
    try std.testing.expect(model.busy);
    const write=fx.pendingFileAt(0).?;
    try std.testing.expect(write.bytes.len>sdk.max_effect_argv_bytes);
    try std.testing.expectEqual(@as(usize,0),fx.pendingSpawnCount());
    const data=try std.json.parseFromSlice(struct{cliArgs:[]const []const u8,text:[]const u8},std.testing.allocator,write.bytes,.{.ignore_unknown_fields=true});defer data.deinit();
    try std.testing.expectEqualStrings("/fixture/a b; $(unchanged)",data.value.cliArgs[3]);
    try std.testing.expectEqual(@as(usize,4096),data.value.text.len);
    completeEffect(&model,&fx,.{.create_file_saved=.{.key=108,.outcome=.ok}});
    const request=fx.pendingSpawnAt(0).?;
    try std.testing.expectEqual(@as(usize,5),request.argv.len);
    try std.testing.expectEqualStrings("--request-file",request.argv[3]);
    completeEffect(&model,&fx,.{.command_done=.{.key=101,.code=1,.reason=.exited}});
    main.update(&model,.new_session,&fx);
    try std.testing.expectEqualStrings("",model.formCliArgs());
}

fn sessionRows(model: *const main.Model, arena: std.mem.Allocator) []const main.Row {
    const rows=model.visible(arena);
    const out=arena.alloc(main.Row,rows.len) catch return &.{};
    var count:usize=0;
    for(rows)|r| { if(!r.header){out[count]=r;count+=1;} }
    return out[0..count];
}

fn completeEffect(model: *main.Model, fx: *main.Effects, msg: main.Msg) void {
    // Unit tests dispatch the same result message after retiring the fake request.
    // Runtime integration owns queue delivery; no subprocess or file is created here.
    fx.deinit();fx.*=main.Effects.init(std.testing.allocator);fx.executor=.fake;
    main.update(model,msg,fx);
}

test "create retries reuse session and request IDs until the draft changes" {
    var model:main.Model=.{};defer model.deinit();
    var fx=main.Effects.init(std.testing.allocator);defer fx.deinit();fx.executor=.fake;
    main.update(&model,.new_session,&fx);
    model.title_buffer.set("Review");model.project_buffer.set("/fixture/workspace");model.prompt_buffer.set("Inspect the fixture");
    main.update(&model,.create_session,&fx);
    const first=try std.testing.allocator.dupe(u8,model.create_id.text());defer std.testing.allocator.free(first);
    try std.testing.expectEqual(@as(usize,36),first.len);
    const data=try std.json.parseFromSlice(struct{id:[]const u8,requestId:[]const u8},std.testing.allocator,fx.pendingFileAt(0).?.bytes,.{.ignore_unknown_fields=true,.allocate=.alloc_always});defer data.deinit();
    try std.testing.expectEqualStrings(first,data.value.id);
    try std.testing.expectEqualStrings(first,data.value.requestId);
    completeEffect(&model,&fx,.{.create_file_saved=.{.key=108,.outcome=.ok}});
    const first_path=try std.testing.allocator.dupe(u8,fx.pendingSpawnAt(0).?.argv[4]);defer std.testing.allocator.free(first_path);
    // A failed reply may have happened after the backend committed the intent.
    completeEffect(&model,&fx,.{.command_done=.{.key=101,.code=1,.reason=.exited,.output="{\"ok\":false,\"error\":{\"message\":\"Connection lost\"}}"}});
    main.update(&model,.create_session,&fx);
    try std.testing.expectEqualStrings(first,model.create_id.text());
    try std.testing.expectEqualStrings(first_path,fx.pendingFileAt(0).?.path);
    completeEffect(&model,&fx,.{.create_file_saved=.{.key=108,.outcome=.ok}});
    completeEffect(&model,&fx,.{.command_done=.{.key=101,.code=1,.reason=.exited}});
    model.prompt_buffer.set("Inspect a different fixture");
    main.update(&model,.create_session,&fx);
    try std.testing.expect(!std.mem.eql(u8,first,model.create_id.text()));
    completeEffect(&model,&fx,.{.create_file_saved=.{.key=108,.outcome=.ok}});
    completeEffect(&model,&fx,.{.command_done=.{.key=101,.code=0,.reason=.exited,.output="{\"ok\":true,\"session\":{\"id\":\"created\"}}"}});
    try std.testing.expect(!model.create_intent_valid);
    try std.testing.expectEqualStrings("",model.create_id.text());
    main.update(&model,.new_session,&fx);
    model.title_buffer.set("Cancelled");model.project_buffer.set("/fixture/workspace");
    main.update(&model,.create_session,&fx);
    completeEffect(&model,&fx,.{.create_file_saved=.{.key=108,.outcome=.io_failed}});
    try std.testing.expectEqual(@as(usize,0),fx.pendingSpawnCount());
    main.update(&model,.cancel_form,&fx);
    try std.testing.expect(!model.create_intent_valid);
}

test "human attention copy explains blocked controls and rejects direct release" {
    var model:main.Model=.{};defer model.deinit();
    var fx=main.Effects.init(std.testing.allocator);defer fx.deinit();fx.executor=.fake;
    try loadSnapshot(&model,&fx,"{\"sessions\":[{\"id\":\"one\",\"owner\":\"human\",\"alive\":true,\"pending\":true,\"status\":\"attention\"}]}");
    try std.testing.expect(std.mem.startsWith(u8,model.attentionHint(),"Verifica la richiesta"));
    try std.testing.expect(std.mem.startsWith(u8,model.controlHint(),"Concludi la richiesta"));
    main.update(&model,.release_control,&fx);
    try std.testing.expect(!model.busy);
    try std.testing.expectEqual(@as(usize,0),fx.pendingSpawnCount());
}

test "runtime paints and accepts input after twelve terminal reattachments" {
    const allocator=std.testing.allocator;
    const harness=try sdk.TestHarness().create(allocator,.{.size=sdk.geometry.SizeF.init(1380,900)});
    defer harness.destroy(allocator);
    harness.null_platform.gpu_surfaces=true;
    const views=[_]sdk.ShellView{.{.label="harbor-test-canvas",.kind=.gpu_surface,.fill=true}};
    const windows=[_]sdk.ShellWindow{.{.label="main",.title="Harbor test",.width=1380,.height=900,.views=&views}};
    const TestApp=sdk.UiApp(main.Model,main.Msg);
    const app_state=try TestApp.create(allocator,.{.name="harbor-test",.scene=.{.windows=&windows},.canvas_label="harbor-test-canvas",.update_fx=main.update,.markup=.{.source=main.app_markup}});
    defer app_state.destroy();defer app_state.model.deinit();
    app_state.effects.executor=.fake;
    const app=app_state.app();
    try harness.start(app);
    try harness.runtime.dispatchPlatformEvent(app,.{.gpu_surface_frame=.{.label="harbor-test-canvas",.size=sdk.geometry.SizeF.init(1380,900),.scale_factor=1,.frame_index=1,.timestamp_ns=1_000_000}});
    for([_][]const u8{
        "{\"type\":\"snapshot-begin\",\"snapshotId\":\"runtime\",\"count\":2}",
        "{\"type\":\"snapshot-chunk\",\"snapshotId\":\"runtime\",\"sessions\":[{\"id\":\"one\",\"alive\":true,\"runId\":\"run-one\"},{\"id\":\"two\",\"alive\":true,\"runId\":\"run-two\"}]}",
        "{\"type\":\"snapshot-end\",\"snapshotId\":\"runtime\"}",
    })|line| try app_state.dispatch(&harness.runtime,1,.{.status_line=.{.key=100,.line=line}});
    try std.testing.expectEqual(@as(usize,1),app_state.effects.pendingPtyCount());
    const key=app_state.model.terminal_key;
    var previous:[32]u8=undefined;var previous_len:usize=0;
    for(0..12)|i| {
        if(i>0){
            try app_state.dispatch(&harness.runtime,1,.{.select=if(i%2==0)"one" else "two"});
            try std.testing.expect(app_state.model.detaching);
            try app_state.effects.feedPtyExit(key,0,0,.cancelled,0);
            try harness.runtime.dispatchPlatformEvent(app,.wake);
        }
        try std.testing.expectEqual(key,app_state.model.terminal_key);
        try std.testing.expectEqual(@as(usize,1),app_state.effects.pendingPtyCount());
        var buffer:[32]u8=undefined;const marker=try std.fmt.bufPrint(&buffer,"attachment-{d}-ready",.{i});
        try app_state.effects.feedPtyOutput(key,marker);
        try harness.runtime.dispatchPlatformEvent(app,.wake);
        try harness.runtime.dispatchPlatformEvent(app,.frame_requested);
        const lookup=app_state.terminal_sessions.lookup().?;
        const grid=lookup.resolve(lookup.context,key).?;
        try std.testing.expect(grid.running);
        try std.testing.expect(std.mem.indexOf(u8,grid.screen_text,marker)!=null);
        if(previous_len>0)try std.testing.expect(std.mem.indexOf(u8,grid.screen_text,previous[0..previous_len])==null);
        try std.testing.expect(app_state.terminal_sessions.textInput(key,"hello"));
        try std.testing.expect(std.mem.endsWith(u8,app_state.effects.ptyWrittenBytes(key),"hello"));
        @memcpy(previous[0..marker.len],marker);previous_len=marker.len;
    }
}

test "many sessions of one provider remain independently selectable and paginated" {
    var sessions: [55]main.Session=undefined;
    var ids:[55][12]u8=undefined;
    for(&sessions,0..)|*s,i| { const id=try std.fmt.bufPrint(&ids[i],"session-{d}",.{i});s.*=.{.id=id,.title=id,.provider="codex",.project="/test/project",.alive=i%2==0,.status=if(i%2==0)"ready" else "stopped"}; }
    var json:std.Io.Writer.Allocating=.init(std.testing.allocator);defer json.deinit();
    try std.json.Stringify.value(.{.sessions=&sessions},.{},&json.writer);
    var model:main.Model=.{};
    var fx=main.Effects.init(std.testing.allocator);defer fx.deinit();fx.executor=.fake;
    try loadSnapshot(&model,&fx,json.written());
    defer model.deinit();
    try std.testing.expectEqual(@as(usize,55),model.allCount());
    var arena=std.heap.ArenaAllocator.init(std.testing.allocator);defer arena.deinit();
    // Live sessions are listed before closed ones; each section has one header per page.
    const first=model.visible(arena.allocator());
    try std.testing.expect(first[0].header and first[0].group==.active);
    try std.testing.expectEqual(@as(usize,20),sessionRows(&model,arena.allocator()).len);
    try std.testing.expectEqualStrings("session-0",first[1].id);
    main.update(&model,.next_page,&fx);
    const second=sessionRows(&model,arena.allocator());
    try std.testing.expectEqualStrings("session-40",second[0].id);
    try std.testing.expectEqualStrings("session-1",second[8].id);
    main.update(&model,.{.select="session-31"},&fx);try std.testing.expectEqualStrings("session-31",model.selectedTitle());
    main.update(&model,.{.toggle_group=.closed},&fx);try std.testing.expectEqual(@as(usize,28),model.filteredCount());
    try std.testing.expectEqualStrings("session-31",model.selectedId());
    try std.testing.expectEqual(@as(usize,1),model.page);
    // A search ignores collapsed sections so a match is never hidden.
    model.search_buffer.set("session-31");model.page=0;
    try std.testing.expectEqual(@as(usize,1),sessionRows(&model,arena.allocator()).len);
}

test "human and bot ownership guard UI actions independently of process liveness" {
    var model:main.Model=.{};var fx=main.Effects.init(std.testing.allocator);defer fx.deinit();fx.executor=.fake;
    try loadSnapshot(&model,&fx,"{\"sessions\":[{\"id\":\"a\",\"owner\":\"grok\",\"alive\":true,\"pending\":true,\"status\":\"running\"}]}");
    defer model.deinit();
    try std.testing.expect(!model.human());try std.testing.expect(model.cannotStop());try std.testing.expect(model.cannotRelease());
    main.update(&model,.stop_session,&fx);try std.testing.expect(!model.busy);
    main.update(&model,.take_control,&fx);try std.testing.expect(model.busy);
}

test "corrupt or partial snapshots never replace known session state" {
    var model:main.Model=.{};var fx=main.Effects.init(std.testing.allocator);defer fx.deinit();fx.executor=.fake;
    try loadSnapshot(&model,&fx,"{\"sessions\":[{\"id\":\"original\",\"title\":\"Keep me\"}]}");
    defer model.deinit();
    main.update(&model,.{.status_line=.{.key=100,.line="{broken"}},&fx);
    try std.testing.expectEqualStrings("Keep me",model.selectedTitle());
    main.update(&model,.{.status_line=.{.key=100,.line="{}",.truncated=true}},&fx);
    try std.testing.expectEqualStrings("Keep me",model.selectedTitle());
    try std.testing.expect(!model.connected);
}

test "terminal attachment waits for layout and uses one live attachment when selection changes" {
    var model:main.Model=.{};var fx=main.Effects.init(std.testing.allocator);defer fx.deinit();fx.executor=.fake;
    try loadSnapshot(&model,&fx,"{\"sessions\":[{\"id\":\"one\",\"alive\":true},{\"id\":\"two\",\"alive\":true}]}");
    defer model.deinit();
    try std.testing.expectEqual(@as(usize,0),fx.pendingPtyCount());
    main.update(&model,.{.terminal_state=.{.cols=100,.rows=30,.scrollback=0,.history=0}},&fx);
    try std.testing.expect(model.attached);const first_key=model.terminal_key;
    main.update(&model,.{.select="two"},&fx);try std.testing.expect(model.detaching);
    completeEffect(&model,&fx,.{.terminal_event=.{.key=first_key,.kind=.exit}});
    try std.testing.expect(!model.detaching);try std.testing.expectEqual(first_key,model.terminal_key);
    try std.testing.expectEqualStrings("two",model.attached_id.text());
}

test "markup builds empty, creation, selected and many-row states" {
    var arena=std.heap.ArenaAllocator.init(std.testing.allocator);defer arena.deinit();
    var view=try canvas.MarkupView(main.Model,main.Msg).init(arena.allocator(),main.app_markup);
    var model:main.Model=.{};var ui=main.AppUi.init(arena.allocator());
    _=try ui.finalize(try view.build(&ui,&model));
    model.creating=true;model.advanced=true;ui=main.AppUi.init(arena.allocator());_=try ui.finalize(try view.build(&ui,&model));
    var fx=main.Effects.init(std.testing.allocator);defer fx.deinit();fx.executor=.fake;
    try loadSnapshot(&model,&fx,"{\"sessions\":[{\"id\":\"one\",\"title\":\"Review\",\"status\":\"attention\",\"alive\":true}]}");
    defer model.deinit();model.creating=false;model.details=true;model.renaming=true;
    ui=main.AppUi.init(arena.allocator());_=try ui.finalize(try view.build(&ui,&model));
}

test "sections put attention first, keep the archive separate and select what needs a human" {
    var model:main.Model=.{};defer model.deinit();
    var fx=main.Effects.init(std.testing.allocator);defer fx.deinit();fx.executor=.fake;
    try loadSnapshot(&model,&fx,
        \\{"sessions":[
        \\{"id":"old","title":"Old","status":"archived"},
        \\{"id":"closed","title":"Closed","status":"stopped"},
        \\{"id":"live","title":"Live","alive":true,"status":"ready","owner":"grok"},
        \\{"id":"blocked","title":"Blocked","alive":true,"status":"attention","error":"PERMISSION_REQUIRED"}]}
    );
    try std.testing.expectEqualStrings("blocked",model.selectedId());
    try std.testing.expectEqualStrings("Autorizzazione richiesta",model.attentionTitle());
    var arena=std.heap.ArenaAllocator.init(std.testing.allocator);defer arena.deinit();
    const rows=model.visible(arena.allocator());
    try std.testing.expectEqual(@as(usize,6),rows.len);
    try std.testing.expect(rows[0].header and rows[0].group==.attention);
    try std.testing.expectEqualStrings("Da controllare · 1",rows[0].heading);
    try std.testing.expectEqualStrings("blocked",rows[1].id);
    try std.testing.expect(rows[1].attention and rows[1].selected);
    try std.testing.expectEqualStrings("live",rows[3].id);
    try std.testing.expect(rows[3].grok and rows[3].ready);
    try std.testing.expectEqualStrings("closed",rows[5].id);
    try std.testing.expectEqual(@as(usize,3),model.allCount());
    try std.testing.expectEqual(@as(usize,1),model.archivedCount());
    main.update(&model,.filter_archived,&fx);
    const archive=model.visible(arena.allocator());
    try std.testing.expectEqual(@as(usize,2),archive.len);
    try std.testing.expectEqualStrings("old",archive[1].id);
    main.update(&model,.filter_all,&fx);
    main.update(&model,.{.toggle_group=.active},&fx);
    const collapsed=model.visible(arena.allocator());
    try std.testing.expect(collapsed[2].header and collapsed[2].collapsed);
    try std.testing.expectEqualStrings("closed",collapsed[4].id);
    // Keyboard stepping walks visible rows only.
    main.update(&model,.select_next,&fx);
    try std.testing.expectEqualStrings("closed",model.selectedId());
    main.update(&model,.select_next,&fx);
    try std.testing.expectEqualStrings("closed",model.selectedId());
    main.update(&model,.select_previous,&fx);
    try std.testing.expectEqualStrings("blocked",model.selectedId());
    main.update(&model,.{.select_index=1},&fx);
    try std.testing.expectEqualStrings("closed",model.selectedId());
}

test "timestamps render as compact relative Italian times" {
    var arena=std.heap.ArenaAllocator.init(std.testing.allocator);defer arena.deinit();
    const a=arena.allocator();
    const base=main.parseTimestamp("2026-10-19T07:14:26.881Z").?;
    try std.testing.expectEqual(@as(i64,1792394066),base);
    try std.testing.expectEqualStrings("adesso",main.relativeTime(a,base+10,"2026-10-19T07:14:26.881Z"));
    try std.testing.expectEqualStrings("5 min",main.relativeTime(a,base+300,"2026-10-19T07:14:26.881Z"));
    try std.testing.expectEqualStrings("3 h",main.relativeTime(a,base+3*3600+5,"2026-10-19T07:14:26.881Z"));
    try std.testing.expectEqualStrings("ieri",main.relativeTime(a,base+30*3600,"2026-10-19T07:14:26.881Z"));
    try std.testing.expectEqualStrings("4 g",main.relativeTime(a,base+4*86400,"2026-10-19T07:14:26.881Z"));
    try std.testing.expectEqualStrings("19 ott",main.relativeTime(a,base+30*86400,"2026-10-19T07:14:26.881Z"));
    try std.testing.expectEqualStrings("29 feb",main.relativeTime(a,base,"2024-02-29T23:59:59Z"));
    try std.testing.expectEqualStrings("",main.relativeTime(a,0,"2026-10-19T07:14:26.881Z"));
    try std.testing.expectEqualStrings("",main.relativeTime(a,base,"garbage"));
    try std.testing.expect(main.parseTimestamp(null)==null);
}

test "shortcuts map to session commands without claiming plain keys" {
    try std.testing.expectEqual(main.Msg.new_session,main.onCommand("session.new").?);
    try std.testing.expectEqual(main.Msg.select_next,main.onCommand("session.next").?);
    try std.testing.expectEqual(@as(usize,0),main.onCommand("session.1").?.select_index);
    try std.testing.expectEqual(@as(usize,8),main.onCommand("session.9").?.select_index);
    try std.testing.expect(main.onCommand("session.0")==null);
    try std.testing.expect(main.onCommand("unknown")==null);
}

test "failures persist until dismissed while confirmations expire" {
    var model:main.Model=.{};defer model.deinit();
    var fx=main.Effects.init(std.testing.allocator);defer fx.deinit();fx.executor=.fake;
    try loadSnapshot(&model,&fx,"{\"sessions\":[{\"id\":\"one\",\"owner\":\"grok\",\"alive\":true,\"status\":\"ready\"}]}");
    main.update(&model,.take_control,&fx);
    completeEffect(&model,&fx,.{.command_done=.{.key=101,.code=1,.reason=.exited,.output="{\"ok\":false,\"error\":{\"code\":\"CONTROL_DENIED\",\"message\":\"denied\"}}"}});
    try std.testing.expect(model.showFailure() and !model.showNotice());
    try std.testing.expect(std.mem.startsWith(u8,model.notice(),"Grok ha il controllo"));
    main.update(&model,.{.notice_expired=.{.key=2}},&fx);
    try std.testing.expect(model.showFailure());
    main.update(&model,.dismiss_notice,&fx);
    try std.testing.expect(!model.showFailure());
    main.update(&model,.take_control,&fx);
    completeEffect(&model,&fx,.{.command_done=.{.key=101,.code=0,.reason=.exited,.output="{\"ok\":true}"}});
    try std.testing.expect(model.showNotice() and model.noticeSuccess());
    main.update(&model,.{.notice_expired=.{.key=2}},&fx);
    try std.testing.expect(!model.showNotice());
}

test "context menu actions target their own row and the form defaults to that session" {
    var model:main.Model=.{};defer model.deinit();
    var fx=main.Effects.init(std.testing.allocator);defer fx.deinit();fx.executor=.fake;
    try loadSnapshot(&model,&fx,"{\"sessions\":[{\"id\":\"a\",\"title\":\"A\",\"alive\":true,\"status\":\"ready\"},{\"id\":\"b\",\"title\":\"B\",\"provider\":\"claude\",\"project\":\"/work/shop\"}]}");
    try std.testing.expectEqualStrings("a",model.selectedId());
    main.update(&model,.{.row_rename="b"},&fx);
    try std.testing.expectEqualStrings("b",model.selectedId());
    try std.testing.expect(model.renaming);
    try std.testing.expectEqualStrings("B",model.renameText());
    main.update(&model,.{.row_archive="b"},&fx);
    const request=fx.pendingSpawnAt(fx.pendingSpawnCount()-1).?;
    try std.testing.expectEqualStrings("archive",request.argv[2]);
    try std.testing.expectEqualStrings("b",request.argv[3]);
    completeEffect(&model,&fx,.{.command_done=.{.key=101,.code=0,.reason=.exited,.output="{\"ok\":true}"}});
    main.update(&model,.new_session,&fx);
    try std.testing.expect(model.form_claude);
    try std.testing.expectEqualStrings("/work/shop",model.formProject());
    // The session name is optional and defaults to the project folder.
    try std.testing.expectEqualStrings("shop",model.effectiveTitle());
    try std.testing.expect(!model.cannotCreate());
    var arena=std.heap.ArenaAllocator.init(std.testing.allocator);defer arena.deinit();
    try std.testing.expectEqual(@as(usize,1),model.recentProjects(arena.allocator()).len);
    main.update(&model,.{.choose_provider="codex"},&fx);
    try std.testing.expect(!model.form_claude);
}

test "system appearance and window chrome changes re-theme and re-layout live" {
    var model:main.Model=.{};defer model.deinit();
    var fx=main.Effects.init(std.testing.allocator);defer fx.deinit();fx.executor=.fake;
    // Before the first snapshot the sidebar must not claim the registry is empty.
    try std.testing.expect(std.mem.startsWith(u8,model.emptyTitle(),"Caricamento"));
    const light=main.tokens(&model);
    main.update(&model,.{.appearance=.{.color_scheme=.dark}},&fx);
    const dark=main.tokens(&model);
    try std.testing.expect(model.dark);
    // The terminal inherits background and text, so both must flip with the scheme.
    try std.testing.expect(dark.colors.background.r<0.1 and light.colors.background.r>0.9);
    try std.testing.expect(dark.colors.text.r>0.8 and light.colors.text.r<0.2);
    main.update(&model,.{.appearance=.{.color_scheme=.dark,.high_contrast=true}},&fx);
    const contrast=main.tokens(&model);
    try std.testing.expect(!std.meta.eql(contrast.colors.background,dark.colors.background) or !std.meta.eql(contrast.colors.accent,dark.colors.accent));
    main.update(&model,.{.appearance=.{.color_scheme=.light}},&fx);
    try std.testing.expect(std.meta.eql(main.tokens(&model).colors.background,light.colors.background));
    // Hidden-titlebar insets move the header below the traffic lights; fullscreen reports zero.
    try std.testing.expectEqual(@as(f32,52),model.headerHeight());
    main.update(&model,.{.chrome=.{.insets=.{.top=60,.left=78}}},&fx);
    try std.testing.expectEqual(@as(f32,60),model.headerHeight());
    // The traffic-light frame is the vertical truth when the band is taller than the lights' row.
    main.update(&model,.{.chrome=.{.insets=.{.top=66,.left=78},.buttons=sdk.geometry.RectF.init(20,19,52,14)}},&fx);
    try std.testing.expectEqual(@as(f32,52),model.headerHeight());
    try std.testing.expectEqual(@as(f32,78),model.chromeLeading());
    main.update(&model,.{.chrome=.{}},&fx);
    try std.testing.expectEqual(@as(f32,16),model.chromeLeading());
}
