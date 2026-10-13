import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { reconcileOneiros } from '../src/oneiros.js';
import { findSiblingDir, loadSibling } from '../src/engine.js';
import { performUpdate, type UpdateDeps } from '../src/commands/update.js';
import { linkEngineInto } from './helpers/engine.js';
const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(r=>rmSync(r,{recursive:true,force:true})));
async function fixture() {
 const root=mkdtempSync(join(tmpdir(),'oneiros-upgrade-')); roots.push(root); linkEngineInto(root);
 mkdirSync(join(root,'db')); mkdirSync(join(root,'.fortytwo')); mkdirSync(join(root,'context'));
 writeFileSync(join(root,'.env'),'DB_PATH=db/existing.db\n');
 writeFileSync(join(root,'.fortytwo/identity.json'),'{"identityVersion":1,"answers":{"agent_name":"Test assistant"}}');
 const files: string[] = JSON.parse(readFileSync(join(findSiblingDir('@justfortytwo/persona',root)!, 'manifest.json'),'utf8')).files.map((f:any)=>f.output);
 for (const file of files) { mkdirSync(dirname(join(root,file)),{recursive:true}); writeFileSync(join(root,file),'Curated exact bytes: '+file+'\r\n'); }
 const memory:any=await loadSibling('@justfortytwo/memory',root);
 const h=memory.openDb(join(root,'db/existing.db')); await memory.runMigrations(h.k);
 h.raw.prepare("INSERT INTO memories(content) VALUES ('historical owner preferences')").run();
 await h.k.destroy(); h.raw.close();
 return {root,files,memory};
}
it('update preserves all curated files and identity, skips history and seeds exactly one persistent job',async()=>{
 const {root,files,memory}=await fixture();
 const before=new Map([...files,'.fortytwo/identity.json'].map(f=>[f,readFileSync(join(root,f))]));
 let version='1.0.0-0';
 const deps:UpdateDeps={readState:()=>({stateVersion:1,current:[],previous:null,lastUpdatedAt:''}), installedVersion:()=>version,
 compatRanges:{'@justfortytwo/persona':'1.0.0-1'},fetchVersions:async()=>['1.0.0-1'],install:()=>{version='1.0.0-1';return {ok:true,detail:''};},
 doctor:async()=>({ok:true,results:[]}),record:()=>{},reconcile:()=>reconcileOneiros(root, 'db/existing.db'),out:()=>{},err:()=>{}};
 expect(await performUpdate(deps,{})).toBe(0);
 const checkpoint=readFileSync(join(root,'.fortytwo/oneiros/checkpoint.json'),'utf8');
 expect(JSON.parse(checkpoint).position).toBe(1);
 const h=memory.openDb(join(root,'db/existing.db'));
 try {
  const persona:any=await loadSibling('@justfortytwo/persona',root);
  const source={head:()=>memory.memoryHead(h),delta:(c:any)=>memory.memoryDelta(h,c)};
  expect(persona.hasWork(root,source)).toBe(false);
  h.raw.prepare("INSERT INTO memories(content) VALUES ('new evidence')").run();
  expect(await performUpdate(deps,{})).toBe(0);
  expect(readFileSync(join(root,'.fortytwo/oneiros/checkpoint.json'),'utf8')).toBe(checkpoint);
  expect(persona.hasWork(root,source)).toBe(true);
  const jobs=memory.listActive(h).filter((j:any)=>j.kind==='persona.oneiros');
  expect(jobs).toHaveLength(1); expect(jobs[0].recurrence).toBe('17 3 * * *');
  for(const [f,bytes] of before) expect(readFileSync(join(root,f))).toEqual(bytes);
 } finally {await h.k.destroy();h.raw.close();}
});
it('dry-run on an unchanged version does not initialize maintenance',async()=>{
 const {root}=await fixture();
 const deps:UpdateDeps={readState:()=>({stateVersion:1,current:[],previous:null,lastUpdatedAt:''}),installedVersion:()=> '1.0.0-1',compatRanges:{'@justfortytwo/persona':'1.0.0-1'},fetchVersions:async()=>['1.0.0-1'],install:()=>{throw new Error('install');},doctor:async()=>({ok:true,results:[]}),record:()=>{},reconcile:()=>reconcileOneiros(root, 'db/existing.db'),out:()=>{},err:()=>{}};
 expect(await performUpdate(deps,{dryRun:true})).toBe(0);
 expect(existsSync(join(root,'.fortytwo/oneiros'))).toBe(false);
});

it('repairs interruption between checkpoint initialization and job seeding without resetting the baseline',async()=>{
 const {root,memory}=await fixture(); const persona:any=await loadSibling('@justfortytwo/persona',root);
 const h=memory.openDb(join(root,'db/existing.db'));
 try {
  persona.initialize(root,memory.memoryHead(h));
  const checkpoint=readFileSync(join(root,'.fortytwo/oneiros/checkpoint.json'),'utf8');
  h.raw.prepare("INSERT INTO memories(content) VALUES ('arrived during interrupted upgrade')").run();
  await reconcileOneiros(root,'db/existing.db');
  expect(readFileSync(join(root,'.fortytwo/oneiros/checkpoint.json'),'utf8')).toBe(checkpoint);
  expect(memory.listActive(h).filter((j:any)=>j.kind==='persona.oneiros')).toHaveLength(1);
 } finally {await h.k.destroy();h.raw.close();}
});
