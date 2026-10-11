import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initializeGalaxyIntegration } from '../../galaxy-core/src/local-store.mjs';
import { createLocalContextStore } from '../src/local-context-store.mjs';
import { createContextFlow } from '../src/context-flow.mjs';
import { createContextDraftMenu } from '../../../integrations/host-adapters/opencode-stable/context-draft-menu.mjs';
import { createAssistanceMenu } from '../../../integrations/host-adapters/opencode-stable/assistance-menu.mjs';

const wait=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Context UI did not settle');};
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'galaxy-context-ui-')),pending=new Set();
  const track=promise=>{pending.add(promise);promise.then(()=>pending.delete(promise),()=>pending.delete(promise));return promise;};
  t.after(async()=>{while(pending.size)await Promise.allSettled(pending);await rm(directory,{recursive:true,force:true});});
  await initializeGalaxyIntegration(directory,{profile:'coding-case',source:'test'});
  const identity=JSON.parse(await readFile(join(directory,'galaxy-id.json'),'utf8')),endpoint='https://fixture.example';
  const store=createLocalContextStore({dataDirectory:directory,endpoint}),now=Math.floor(Date.now()/1000);
  let record={view:'requester',state:'active',requesterId:identity.id,version:4,paused:false,
    request:{id:randomUUID(),caseId:randomUUID(),title:'Compiler collaboration',problem:'Build failed',attemptedApproaches:[],scope:'Inspect selected diagnostics',collaboration:'open-assistance',enrollmentExpiresAt:now+3600},
    selected:{providerId:'GUID'+'A'.repeat(28)},agreedScope:'Inspect selected diagnostics',events:[{event:{kind:'confirm',id:randomUUID()}}],offers:[],
    contextAccessGranted:false,paymentExecuted:false,capabilityVerified:false};
  const authorization={subjectId:identity.id,bindingId:randomUUID(),scopes:['binding','consent','context','assistance'],bindingExpiresAt:now+900,endpoint};
  const previews=[],inputs=[];let reads=0;
  const controller={cancel(){},getAssistance:async()=>{reads++;return record;},queryContext:async()=>({items:[]}),
    createContextDraft:input=>store.createDraft(input),getContextDraft:id=>store.getDraft(id),saveContextDraft:input=>store.saveDraft(input),
    previewContextFile:input=>store.previewFile(input),
    rebaseContextDraft:input=>store.rebaseDraft(input),listContextDrafts:()=>store.listDrafts(),forgetContextDraft:id=>store.forgetDraft(id),
    listContextOperations:()=>store.list(),getLocalContextOperation:id=>store.get(id),forgetContextOperation:id=>store.forget(id)};
  const flow=createContextFlow({endpoint,journal:store,
    sessions:{readAuthorization:async()=>authorization,isAuthorizationCurrent:async()=>true,matchesAuthorization:()=>true},
    assistanceRead:async()=>controller.getAssistance(),signIntent:async()=>{throw new Error('No signing before confirmation');}});
  controller.prepareContext=async input=>{inputs.push(input);const preview=await flow.prepare(input);previews.push(preview);return preview;};
  for(const [name,method] of Object.entries(controller))if(name!=='cancel')controller[name]=(...args)=>track(Promise.resolve().then(()=>method(...args)));
  function host({root=false,offline=false}={}){
    let page,current=true;
    const menu=(root?createAssistanceMenu:createContextDraftMenu)({controller,language:'zh-CN',isCurrent:()=>current,canSubmit:!offline,scopes:authorization.scopes,
      onBack:()=>{current=false;},onOpenGrant:()=>{throw new Error('No implicit remote material read');},
      onConfirm:(input,back)=>void track(controller.prepareContext(input).then(()=>back())),
      select:value=>{page={kind:'select',...value};},prompt:value=>{page={kind:'prompt',...value};},info:(title,text,onBack)=>{page={kind:'info',title,text,onBack};}});
    return {menu,page:()=>page,close:()=>{current=false;},choose(title){const option=page.options?.find(item=>item.title===title);assert.ok(option,title);page.routes[option.number]();},
      async enter(text){const old=page;assert.equal(old.kind,'prompt');old.onConfirm(text);await wait(()=>page!==old&&page.kind!=='info');}};
  }
  return {store,controller,host,previews,inputs,directory,endpoint,record:()=>record,setRecord:value=>{record=value;},reads:()=>reads};
}

test('native material drafts preserve multiple excerpts across offline restart and freeze exact IDs only at preview',async t=>{
  const f=await fixture(t);let h=f.host({root:true});h.menu.openRequest(f.record().request.id);
  await wait(()=>h.page()?.kind==='info'&&h.page().title===f.record().request.title);assert.ok(h.page().text.includes(f.record().request.scope));assert.equal(f.previews.length,0);h.page().onBack();
  await wait(()=>h.page()?.options?.some(item=>item.title==='授权选定文本材料'));h.choose('授权选定文本材料');
  await wait(()=>h.page()?.options?.some(item=>item.title==='粘贴文本片段'));h.choose('粘贴文本片段');
  await wait(()=>h.page()?.kind==='prompt');await h.enter('Compiler log');
  const id=(await f.store.listDrafts()).items[0].id;h.close();h=f.host({offline:true});
  const reads=f.reads();h.menu.openDraft(id);await wait(()=>h.page()?.options?.some(item=>item.title==='继续编辑材料'));h.choose('继续编辑材料');
  await h.enter('x'.repeat(4000));h.choose('添加选定片段');await wait(()=>h.page()?.kind==='prompt');await h.enter('Relevant source');await h.enter('export const answer = 42;');
  assert.equal(f.reads(),reads);assert.equal(f.inputs.length,0);
  assert.ok(!h.page().options.some(item=>item.title==='预览接收方、范围和材料'));
  const saved=await createLocalContextStore({dataDirectory:f.directory,endpoint:f.endpoint}).getDraft(id);
  assert.equal(saved.content.materials.length,2);assert.equal(saved.content.materials[0].content.length,4000);
  h.close();h=f.host();h.menu.openDraft(id);await wait(()=>h.page()?.options?.some(item=>item.title==='继续编辑材料'));h.choose('继续编辑材料');
  await wait(()=>h.page()?.options?.some(item=>item.title==='预览接收方、范围和材料'));h.choose('预览接收方、范围和材料');
  await wait(()=>f.previews.length===1);const payload=JSON.parse(f.previews[0].payloadJson),intent=JSON.parse(f.previews[0].intentJson);
  assert.equal(payload.id,id);assert.deepEqual(payload.materials.map(item=>item.id),saved.content.materials.map(item=>item.id));
  assert.equal(payload.materials[0].content.length,4000);assert.equal(payload.materials[1].content,'export const answer = 42;');
  assert.deepEqual(intent.viewers,[saved.content.source.participantId]);assert.equal((await f.store.getDraft(id)).status,'prepared');
});

test('native material recovery requires explicit review even when reconfirmed scope text is unchanged',async t=>{
  const f=await fixture(t);let row=await f.store.createDraft(f.record());
  row=await f.store.saveDraft({id:row.id,expectedRevision:row.revision,content:{...row.content,step:'overview',
    materials:row.content.materials.map(item=>({...item,label:'Saved excerpt',content:'Keep this selected text.'}))}});
  const previous=row.content.source.scopeEventId,newEvent=randomUUID();
  f.setRecord({...f.record(),events:[...f.record().events,{event:{kind:'confirm-scope',id:newEvent}}]});
  const h=f.host();h.menu.openDraft(row.id);await wait(()=>h.page()?.options?.some(item=>item.title==='继续编辑材料'));h.choose('继续编辑材料');
  await wait(()=>h.page()?.options?.some(item=>item.title==='确认当前接收方和范围，重新审阅'));
  assert.ok(!h.page().title.includes(previous)&&!h.page().title.includes(newEvent));assert.equal(f.inputs.length,0);
  h.choose('查看原选择与当前来源');assert.ok(h.page().text.includes(previous)&&h.page().text.includes(newEvent));h.page().onBack();
  await wait(()=>h.page()?.options?.some(item=>item.title==='确认当前接收方和范围，重新审阅'));
  assert.equal((await f.store.getDraft(row.id)).content.source.scopeEventId,previous);
  h.choose('确认当前接收方和范围，重新审阅');await wait(()=>h.page()?.options?.some(item=>item.title==='预览接收方、范围和材料'));
  const updated=await f.store.getDraft(row.id);assert.equal(updated.content.source.scopeEventId,newEvent);
  assert.equal(updated.content.materials[0].content,'Keep this selected text.');assert.equal(f.inputs.length,0);
  h.choose('预览接收方、范围和材料');await wait(()=>f.previews.length===1);assert.equal(JSON.parse(f.previews[0].payloadJson).scopeEventId,newEvent);
});

test('canceled collaboration retains editable local materials and local deletion does not alter the remote record',async t=>{
  const f=await fixture(t);let row=await f.store.createDraft(f.record());
  row=await f.store.saveDraft({id:row.id,expectedRevision:row.revision,content:{...row.content,step:'overview',
    materials:row.content.materials.map(item=>({...item,label:'Diagnostic',content:'Saved diagnostic.'}))}});
  await assert.rejects(f.store.saveDraft({id:row.id,expectedRevision:row.revision,content:{...row.content,source:{...row.content.source,scopeEventId:randomUUID()}}}),/explicit review/);
  await assert.rejects(f.store.saveDraft({id:row.id,expectedRevision:row.revision,content:{...row.content,
    materials:row.content.materials.map(item=>({...item,content:'-----BEGIN PRIVATE KEY-----'}))}}),/Credential material/);
  f.setRecord({...f.record(),state:'canceled'});let h=f.host();h.menu.openDraft(row.id);
  await wait(()=>h.page()?.options?.some(item=>item.title==='继续编辑材料'));h.choose('继续编辑材料');
  await wait(()=>h.page()?.kind==='info'&&h.page().text.includes('active collaboration'));
  assert.equal((await f.store.getDraft(row.id)).content.materials[0].content,'Saved diagnostic.');assert.equal(f.inputs.length,0);
  h.close();h=f.host({offline:true});h.menu.openDraft(row.id);await wait(()=>h.page()?.options?.some(item=>item.title==='删除本地材料草稿'));
  const reads=f.reads();h.choose('删除本地材料草稿');await wait(()=>h.page()?.kind==='select'&&h.page().options.length===0);
  assert.equal((await f.store.listDrafts()).items.length,0);assert.equal(f.reads(),reads);assert.equal(f.record().state,'canceled');
});

test('native file selection previews before saving, survives offline restart and submits only the captured excerpt',async t=>{
  const f=await fixture(t),path=join(f.directory,'build.log');
  await writeFile(path,'private header\nselected diagnostic\nselected source\nprivate tail\n');
  let h=f.host({offline:true});h.menu.create(f.record());
  await wait(()=>h.page()?.options?.some(item=>item.title==='选择文件或日志片段'));h.choose('选择文件或日志片段');
  await h.enter(path);const rangePage=h.page();rangePage.onConfirm('2-3');
  await wait(()=>h.page()?.kind==='info'&&h.page().text.includes('本地文件片段预览'));
  assert.ok(h.page().text.includes('selected diagnostic\nselected source'));assert.ok(!h.page().text.includes('private header'));
  const id=(await f.store.listDrafts()).items[0].id,empty=await f.store.getDraft(id);
  assert.equal(empty.content.materials[0].content,'');assert.equal(f.previews.length,0);assert.equal(f.reads(),0);
  await writeFile(path,'source changed after preview');
  h.page().onBack();h.choose('加入本地草稿');await wait(()=>h.page()?.options?.some(item=>item.title==='build.log:2-3'));
  const saved=await f.store.getDraft(id);assert.equal(saved.content.materials[0].id,empty.content.materials[0].id);
  assert.equal(saved.content.materials[0].content,'selected diagnostic\nselected source');
  assert.ok(!JSON.stringify(saved).includes(f.directory));assert.equal(f.reads(),0);
  h.close();h=f.host();h.menu.openDraft(id);await wait(()=>h.page()?.options?.some(item=>item.title==='继续编辑材料'));h.choose('继续编辑材料');
  await wait(()=>h.page()?.options?.some(item=>item.title==='预览接收方、范围和材料'));h.choose('预览接收方、范围和材料');
  await wait(()=>f.previews.length===1);
  const payload=JSON.parse(f.previews[0].payloadJson);assert.equal(payload.materials[0].content,saved.content.materials[0].content);
  assert.ok(!f.previews[0].payloadJson.includes(f.directory));assert.ok(!f.previews[0].payloadJson.includes('source changed'));
  assert.deepEqual(Object.keys(payload.materials[0]),['id','label','mediaType','content']);
});

test('canceling a pending file preview discards its late result and old callbacks cannot save or read again',async t=>{
  const f=await fixture(t),path=join(f.directory,'cancel.log');await writeFile(path,'diagnostic');
  let release,started=false;const preview=f.controller.previewContextFile;
  f.controller.previewContextFile=async input=>{const result=await preview(input);started=true;await new Promise(resolve=>{release=resolve;});return result;};
  const h=f.host({offline:true});h.menu.create(f.record());
  await wait(()=>h.page()?.options?.some(item=>item.title==='选择文件或日志片段'));h.choose('选择文件或日志片段');
  await h.enter(path);const range=h.page();range.onConfirm('1-1');await wait(()=>started);
  const id=(await f.store.listDrafts()).items[0].id,original=await f.store.getDraft(id);
  h.page().onBack();await wait(()=>h.page()?.options?.some(item=>item.title==='继续编辑材料'));
  const current=h.page();release();await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(h.page(),current);range.onConfirm('1-1');await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(await f.store.getDraft(id),original);assert.equal(h.page(),current);assert.equal(f.reads(),0);
});

test('a file preview cannot overwrite a concurrently edited draft or restore a locally deleted draft',async t=>{
  const f=await fixture(t),path=join(f.directory,'version.log');await writeFile(path,'selected original');
  const h=f.host({offline:true});h.menu.create(f.record());
  await wait(()=>h.page()?.options?.some(item=>item.title==='选择文件或日志片段'));h.choose('选择文件或日志片段');
  await h.enter(path);h.page().onConfirm('1-1');await wait(()=>h.page()?.kind==='info'&&h.page().text.includes('本地文件片段预览'));
  const id=(await f.store.listDrafts()).items[0].id,row=await f.store.getDraft(id);
  const changed=await f.store.saveDraft({id,expectedRevision:row.revision,content:{...row.content,hours:'2'}});
  h.page().onBack();h.choose('加入本地草稿');await wait(()=>h.page()?.kind==='info'&&h.page().text.includes('draft changed'));
  assert.deepEqual(await f.store.getDraft(id),changed);
  await assert.rejects(f.store.previewFile({id,expectedRevision:row.revision,path,startLine:1,endLine:1}),/draft changed/);
  await f.store.forgetDraft(id);
  await assert.rejects(f.store.previewFile({id,expectedRevision:changed.revision,path,startLine:1,endLine:1}),/Invalid Context draft/);
});
