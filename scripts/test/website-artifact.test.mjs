import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {packWebsiteRuntime} from '../website-artifact.mjs';

test('website runtime retains at most the current and previous builds own public assets',async()=>{
 const base=resolve('outputs/assets');mkdirSync(base,{recursive:true});const fixture=mkdtempSync(join(base,'assets-'));
 const content=join(fixture,'content');mkdirSync(content);writeFileSync(join(content,'release.json'),'{}');
 let previous;
 for(let generation=1;generation<=3;generation++){
  const root=join(fixture,'source-'+generation),standalone=join(root,'apps/galaxy-site/.next/standalone/apps/galaxy-site'),staticRoot=join(root,'apps/galaxy-site/.next/static');
  mkdirSync(standalone,{recursive:true});mkdirSync(staticRoot,{recursive:true});writeFileSync(join(standalone,'server.js'),'// build entry');
  writeFileSync(join(staticRoot,'build-'+generation+'.js'),String(generation));
  const artifact=join(fixture,'runtime-'+generation);await packWebsiteRuntime({root,artifact,content,previousRuntime:previous});
  const manifest=JSON.parse(readFileSync(join(artifact,'public-build-assets.json'),'utf8'));
  assert.deepEqual(manifest.files,['build-'+generation+'.js']);
  if(generation>1)assert(existsSync(join(artifact,'apps/galaxy-site/.next/static/build-'+(generation-1)+'.js')));
  if(generation===3)assert(!existsSync(join(artifact,'apps/galaxy-site/.next/static/build-1.js')),'must not accumulate older builds');
  previous=artifact;
 }
 assert(existsSync(join(previous,'start.mjs')));
 await assert.rejects(packWebsiteRuntime({root:join(fixture,'source-3'),artifact:previous,content}),/empty/);
});
