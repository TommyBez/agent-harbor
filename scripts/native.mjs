import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const toolchain=path.join(os.homedir(),'.native/toolchains/zig-0.16.0');
const result=spawnSync(path.join(root,'node_modules/.bin/native'),process.argv.slice(2),{
  cwd:path.join(root,'app'),stdio:'inherit',env:{...process.env,PATH:toolchain+path.delimiter+process.env.PATH},
});
if(result.error)console.error(result.error.message);
process.exitCode=result.status??1;
