import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const run=(cmd,args,cwd=root)=>{const p=spawnSync(cmd,args,{cwd,stdio:'inherit'});if(p.status!==0)process.exit(p.status||1);};
for(const dir of ['bin','broker','scripts','test']) {
  for(const entry of fs.readdirSync(path.join(root,dir),{recursive:true}))if(entry.endsWith('.mjs'))run(process.execPath,['--check',path.join(dir,entry)]);
}
run('native',['markup','check','src/app.native'],path.join(root,'app'));
run('native',['validate','app.zon'],path.join(root,'app'));
console.log('JavaScript syntax, Native markup and manifest checked.');
