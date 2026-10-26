import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {releaseImportResources} from '../src/operations/service-release.mjs';

test('runtime packaging follows literal dynamic imports and refuses a missing downstream module',async()=>{
 const root=await mkdtemp(join(tmpdir(),'galaxy-release-import-'));
 if(dirname(resolve(root))!==resolve(tmpdir())||!basename(root).startsWith('galaxy-release-import-'))throw Error('Unexpected import fixture cleanup target.');
 try{await mkdir(join(root,'src'));await writeFile(join(root,'src/main.mjs'),"import './shared.mjs'; export const load=()=>import('./receipt.mjs');");await writeFile(join(root,'src/shared.mjs'),'export const value=1;');
  await assert.rejects(releaseImportResources(root,['src/main.mjs']),error=>error.code==='release_resource_missing'&&error.resource==='src/receipt.mjs');
  await writeFile(join(root,'src/receipt.mjs'),"export {value} from './shared.mjs';");
  assert.deepEqual((await releaseImportResources(root,['src/main.mjs'])).sort((a,b)=>a<b?-1:a>b?1:0),['src/main.mjs','src/receipt.mjs','src/shared.mjs']);
 }finally{await rm(root,{recursive:true,force:true});}
});
