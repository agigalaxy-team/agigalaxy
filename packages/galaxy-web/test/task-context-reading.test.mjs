import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {selectedTaskMaterial,taskMaterialPath,contextMaterialMatchesWork} from '../src/task-context-reading.mjs';

test('material reading keeps only one valid locator in its exact task and materials view',()=>{
  const task=randomUUID(),grant=randomUUID(),location={pathname:`/app/tasks/${task}`,search:`?section=collaboration&view=materials&material=${grant}`};
  assert.equal(selectedTaskMaterial(task,location),grant);
  assert.equal(selectedTaskMaterial(randomUUID(),location),null);
  for(const search of ['?material='+grant,'?section=collaboration&view=work&material='+grant,location.search+'&material='+grant,location.search.replace(grant,'not-a-grant')])assert.equal(selectedTaskMaterial(task,{...location,search}),null);
});

test('opening and closing keep the original route context and never put material text into the URL',()=>{
  const task=randomUUID(),grant=randomUUID(),location={pathname:`/app/tasks/${task}`,search:'?section=collaboration&view=materials&returnTo=%2Fapp%2Ffind%3Fq%3Dreading',hash:'#context'};
  const opened=taskMaterialPath(task,grant,location),url=new URL(opened,'https://example.invalid');
  assert.equal(url.searchParams.get('returnTo'),'/app/find?q=reading');assert.equal(url.hash,'#context');assert.equal(selectedTaskMaterial(task,url),grant);
  const closed=new URL(taskMaterialPath(task,null,url),'https://example.invalid');assert.equal(closed.searchParams.has('material'),false);assert.equal(closed.searchParams.get('returnTo'),'/app/find?q=reading');
  assert.equal(taskMaterialPath(randomUUID(),grant,location),null);assert.equal(taskMaterialPath(task,'not-a-grant',location),null);
});

test('a current API result must still match this work and actual actor before any body is shown',()=>{
  const task=randomUUID(),view={metadata:{taskId:task,ownerId:'owner',participantId:'recipient'}};
  assert.equal(contextMaterialMatchesWork(view,task,'owner'),true);assert.equal(contextMaterialMatchesWork(view,task,'recipient'),true);
  assert.equal(contextMaterialMatchesWork(view,randomUUID(),'owner'),false);assert.equal(contextMaterialMatchesWork(view,task,'other-reader'),false);assert.equal(contextMaterialMatchesWork(view,task,undefined),false);
});
