import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const run=(cmd,args,cwd=root)=>{const p=spawnSync(cmd,args,{cwd,stdio:'inherit'});if(p.status!==0)process.exit(p.status||1);};
if(process.platform!=='darwin')throw new Error('The desktop bundle currently targets macOS.');
const dist=path.join(root,'dist');fs.mkdirSync(dist,{recursive:true});
const bundle=path.join(dist,'Agent Harbor.app');
run(process.execPath,['scripts/native.mjs','package','--target','macos','--output',bundle,'--binary','zig-out/bin/agent-harbor','--signing','none']);
const resources=path.join(bundle,'Contents/Resources');
const payload=path.join(resources,'harbor');fs.mkdirSync(payload,{recursive:true});
for(const directory of ['bin','broker'])fs.cpSync(path.join(root,directory),path.join(payload,directory),{recursive:true});
fs.mkdirSync(path.join(payload,'scripts'),{recursive:true});fs.copyFileSync(path.join(root,'scripts/gui.mjs'),path.join(payload,'scripts/gui.mjs'));
fs.copyFileSync(path.join(root,'package.json'),path.join(payload,'package.json'));
fs.copyFileSync(path.join(root,'LICENSE'),path.join(resources,'Agent-Harbor-LICENSE'));
fs.mkdirSync(path.join(resources,'runtime'),{recursive:true});fs.copyFileSync(process.execPath,path.join(resources,'runtime/node'));fs.chmodSync(path.join(resources,'runtime/node'),0o755);
const nodeLicense=path.resolve(path.dirname(process.execPath),'../LICENSE');if(fs.existsSync(nodeLicense))fs.copyFileSync(nodeLicense,path.join(resources,'runtime/LICENSE'));
fs.copyFileSync(path.join(root,'node_modules/@native-sdk/cli/LICENSE'),path.join(resources,'Native-SDK-LICENSE'));
// Preserve notices for the terminal engine and bundled SDK font assets.
const notices=path.join(resources,'ThirdPartyLicenses');fs.mkdirSync(notices,{recursive:true});
const packages=path.join(root,'app/zig-pkg');
for(const name of fs.readdirSync(packages)) {
  if(!/^(ghostty-|uucode-)/.test(name))continue;
  for(const filename of ['LICENSE','LICENSE.md']) {
    const source=path.join(packages,name,filename);
    if(fs.existsSync(source))fs.copyFileSync(source,path.join(notices,`${name}-${filename}`));
  }
}
const fontLicense=path.join(root,'node_modules/@native-sdk/cli/src/runtime/testdata/fonts/OFL.txt');
if(fs.existsSync(fontLicense))fs.copyFileSync(fontLicense,path.join(notices,'Native-SDK-font-OFL.txt'));
run('/usr/bin/codesign',['--force','--sign','-',path.join(resources,'runtime/node')]);
run('/usr/bin/codesign',['--force','--deep','--sign','-',bundle]);
run('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);
console.log(`Packaged ${bundle}`);
