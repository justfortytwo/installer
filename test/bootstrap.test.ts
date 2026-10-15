import { readProcessIdentity } from '../src/process-identity.js';
import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { SHIM_SCRIPT } from '../src/shim.js';
const exec = promisify(execFile);

it('external CLI persists itself through real npm and the existing launcher permanently uses it', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ft-bootstrap-'));
  const project = join(base,'project'); const external = join(base,'external');
  const pkg = JSON.parse(readFileSync('package.json','utf8'));
  const cli = '@justfortytwo/installer'; const persona = '@justfortytwo/persona';
  const tarballs = new Map<string,Buffer>();
  const manifests = new Map<string,any>();
  const server = createServer((req,res) => {
    const path = decodeURIComponent(req.url!.split('?')[0]).replace(/^\//,'');
    if (tarballs.has(path)) { res.end(tarballs.get(path)); return; }
    const versions = manifests.get(path);
    if (!versions) { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({name:path,versions,'dist-tags':{latest:Object.keys(versions).at(-1)}}));
  });
  try {
    mkdirSync(project); mkdirSync(external);
    // Compile current source into the external invocation tree, independent of
    // the project's installed CLI. No dependency on a stale repository dist/.
    const build = spawnSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.json','--outDir',join(external,'dist')],{encoding:'utf8'});
    expect(build.status,build.stdout+build.stderr).toBe(0);
    await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
    const registry = `http://127.0.0.1:${(server.address() as any).port}`;
    async function pack(dir:string, manifest:any) {
      writeFileSync(join(dir,'package.json'),JSON.stringify(manifest));
      const {stdout} = await exec('npm',['pack','--ignore-scripts','--json'],{cwd:dir});
      const filename=JSON.parse(stdout)[0].filename;
      tarballs.set(filename,readFileSync(join(dir,filename)));
      manifests.set(manifest.name,{...manifests.get(manifest.name),[manifest.version]:{...manifest,dist:{tarball:`${registry}/${filename}`}}});
    }
    await pack(external,pkg);
    // Previous package fixture is only used for --version, not to simulate the
    // old update implementation. Its version/pin matches shipped installations.
    const old=join(base,'old'); mkdirSync(old); cpSync(join(external,'dist'),join(old,'dist'),{recursive:true});
    await pack(old,{...pkg,version:'1.0.0-9'});
    const p=join(base,'persona');mkdirSync(p);
    await pack(p,{name:persona,version:pkg.fortytwo.compat[persona]});
    const env={...process.env,npm_config_registry:registry,npm_config_cache:join(base,'cache'),npm_config_update_notifier:'false'};
    writeFileSync(join(project,'package.json'),JSON.stringify({name:'bootstrap-fixture',private:true}));
    await exec('npm',['install','--save-exact','--no-audit','--no-fund',`${cli}@1.0.0-9`,`${persona}@${pkg.fortytwo.compat[persona]}`],{cwd:project,env});
    mkdirSync(join(project,'.fortytwo')); mkdirSync(join(project,'context'));
    writeFileSync(join(project,'.fortytwo/state.json'),JSON.stringify({stateVersion:1,current:[],previous:null,lastUpdatedAt:''}));
    const curated=['CLAUDE.md','context/OWNER.md','context/PROFILE.md','context/SOUL.md','.fortytwo/identity.json'];
    for(const f of curated) writeFileSync(join(project,f),`Curated ${f}\r\nunchanged\n`);
    const launcher=join(base,'fortytwo');writeFileSync(launcher,SHIM_SCRIPT,{mode:0o755});
    const run=(file:string,args:string[])=>exec(file,args,{cwd:project,env});
    expect((await run(launcher,['--version'])).stdout).toContain('1.0.0-9');
    const snapshot=()=>Object.fromEntries([...curated,'package.json','package-lock.json'].map(f=>[f,readFileSync(join(project,f),'utf8')]));
    const before=snapshot();
    writeFileSync(join(project,'.fortytwo/runtime.json'),JSON.stringify({runtimeVersion:1,pid:process.pid,processIdentity:readProcessIdentity(process.pid),startedAt:new Date().toISOString(),heartbeatAt:new Date().toISOString(),children:[]}));
    await expect(run(process.execPath,[join(external,'dist/index.js'),'update'])).rejects.toMatchObject({code:1});
    expect(snapshot()).toEqual(before);
    await run(process.execPath,[join(external,'dist/index.js'),'update','--dry-run']);
    rmSync(join(project,'.fortytwo/runtime.json'));
    expect(snapshot()).toEqual(before);
    await run(process.execPath,[join(external,'dist/index.js'),'update']);
    expect(JSON.parse(readFileSync(join(project,'package.json'),'utf8')).dependencies[cli]).toBe(pkg.version);
    expect(JSON.parse(readFileSync(join(project,'package-lock.json'),'utf8')).packages['node_modules/'+cli].version).toBe(pkg.version);
    expect((await run(launcher,['--version'])).stdout).toContain(pkg.version);
    for(const f of curated) expect(readFileSync(join(project,f),'utf8')).toBe(before[f]);
    const after=snapshot();
    await run(launcher,['update']);
    expect(snapshot()).toEqual(after);
    expect((await run(launcher,['--version'])).stdout).toContain(pkg.version);
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    rmSync(base,{recursive:true,force:true});
  }
},30000);
