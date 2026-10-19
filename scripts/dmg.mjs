import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const run=(cmd,args)=>{const p=spawnSync(cmd,args,{cwd:root,stdio:'inherit'});if(p.status!==0)process.exit(p.status||1);};
if(process.platform!=='darwin')throw new Error('DMG creation requires macOS.');
const {version}=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const manifest=fs.readFileSync(path.join(root,'app/app.zon'),'utf8');
if(!manifest.includes(`.version = "${version}"`))throw new Error(`app/app.zon version does not match package.json ${version}.`);
const bundle=path.join(root,'dist/Agent Harbor.app');
if(!fs.existsSync(bundle))throw new Error('Run pnpm package first.');
run('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);
const arch=os.arch()==='arm64'?'arm64':os.arch();
const name=`Agent-Harbor-${version}-${arch}.dmg`;
const output=path.join(root,'dist',name);
// Stage the bundle next to an Applications link so the mounted volume is a drag-to-install window.
const staging=fs.mkdtempSync(path.join(os.tmpdir(),'agent-harbor-dmg-'));
try {
  run('/usr/bin/ditto',[bundle,path.join(staging,'Agent Harbor.app')]);
  fs.symlinkSync('/Applications',path.join(staging,'Applications'));
  fs.rmSync(output,{force:true});
  run('/usr/bin/hdiutil',['create','-volname',`Agent Harbor ${version}`,'-srcfolder',staging,'-fs','HFS+','-format','UDZO','-imagekey','zlib-level=9','-ov',output]);
} finally { fs.rmSync(staging,{recursive:true,force:true}); }
run('/usr/bin/hdiutil',['verify',output]);
const digest=createHash('sha256').update(fs.readFileSync(output)).digest('hex');
fs.writeFileSync(`${output}.sha256`,`${digest}  ${name}\n`);
console.log(`Created ${output}\nSHA-256 ${digest}`);
