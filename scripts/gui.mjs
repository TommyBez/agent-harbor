import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../',import.meta.url));
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const [action,id] = process.argv.slice(2);
try {
  if (action === 'folder') {
    const script = 'POSIX path of (choose folder with prompt "Choose the project for Agent Harbor")';
    process.stdout.write(execFileSync('/usr/bin/osascript',['-e',script],{encoding:'utf8'}));
  } else if (action === 'terminal') {
    if (!/^[a-f0-9-]{36}$/i.test(id || '')) throw new Error('Invalid session identity.');
    const home = process.env.HARBOR_HOME || path.join(os.homedir(),'Library/Application Support/Agent Harbor');
    fs.mkdirSync(path.join(home,'terminals'),{recursive:true,mode:0o700});
    const filename = path.join(home,'terminals',`${id}.command`);
    fs.writeFileSync(filename,`#!/bin/sh\nexport HARBOR_HOME=${quote(home)}\nexec ${quote(process.execPath)} ${quote(path.join(root,'bin/harbor.mjs'))} attach ${quote(id)}\n`,{mode:0o700});
    const child=spawnSync('/usr/bin/open',['-a','Terminal',filename],{stdio:'inherit'});
    process.exitCode=child.status || 0;
  } else throw new Error('Unknown desktop action.');
} catch (error) { process.stderr.write(error.message+'\n');process.exitCode=1; }
