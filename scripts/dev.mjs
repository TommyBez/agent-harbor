import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const child=spawn(path.join(root,'app/zig-out/bin/agent-harbor'),[],{cwd:path.join(root,'app'),stdio:'inherit',env:{...process.env,HARBOR_ROOT:root,HARBOR_NODE:process.execPath}});
child.on('error',error=>{process.stderr.write(`${error.message}\nRun pnpm build first.\n`);process.exitCode=1;});
child.on('exit',code=>process.exitCode=code||0);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
