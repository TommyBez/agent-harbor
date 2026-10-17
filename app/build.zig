const std = @import("std");
const sdk = @import("native_sdk");
pub fn build(b: *std.Build) void { sdk.addApp(b,b.dependency("native_sdk",.{}),.{.name="agent-harbor",.terminal_sessions=true}); }
