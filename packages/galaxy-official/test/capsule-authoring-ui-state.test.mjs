import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {compileFunction} from 'node:vm';
import ts from 'typescript';
import {capsuleWebContinuityFixture} from './capsule-web-continuity-fixture.mjs';
import {createCapsuleWebClient,capsuleCaseSources,capsuleRefKey,currentCapsuleFacts} from "../../galaxy-web/src/features/capsules/capsule-workspace-client.mjs";
import {sha256Hex} from '../src/shared/web-primitives.mjs';
import {capsuleSourceV2Schema} from '../src/shared/capsule-v2-schema.mjs';
import {createGovernanceDraftState} from "../../galaxy-web/src/features/governance/governance-draft-state.ts";

const web=new URL('../../galaxy-web/src/',import.meta.url);
async function declarations(file,names,parent){
 const filename=fileURLToPath(new URL(file,web)),text=await readFile(filename,'utf8'),tree=ts.createSourceFile(filename,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const statements=parent?tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===parent)?.body?.statements:tree.statements;
 assert.ok(statements,'actual UI component exists');
 return names.map(name=>{
  const node=statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name||ts.isVariableStatement(node)&&node.declarationList.declarations.some(item=>item.name.getText(tree)===name));
  assert.ok(node,'actual source declaration '+name);return node.getText(tree);
 }).join('\n');
}
function compile(source,globals,names){
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText;
 return compileFunction(js+'\nreturn {'+names.join(',')+'};',['exports',...Object.keys(globals)])({},...Object.values(globals));
}
const sharedNames=['sourceKind','sourceLocator','uniqueSources','readableCaseSources','methodInputError','readCapsulePermissionSources'];
const shared=compile(await declarations("features/capsules/capsule-authoring-shared.tsx",sharedNames),{capsuleCaseSources,capsuleRefKey,currentCapsuleFacts,capsuleSourceV2Schema},sharedNames);
const authorNames=['textLines','factKey','blank','referenceFromKey','capsuleAuthorInput','migrateCapsuleAuthorInput'];
const author=compile(await declarations("features/capsules/capsule-authoring.tsx",authorNames),{...shared,capsuleRefKey},authorNames);
const stateNames=['same','isCapsuleInputRecord','legacyImport','isCapsuleLocator','capsuleAuthoringDraftKey','capsuleInputDraftKey','prepareCapsuleInput','settleCapsuleInput'];
const state=compile(await declarations("features/capsules/capsule-authoring-state.tsx",stateNames),{sha256Hex},stateNames);
const authorActions=await declarations("features/capsules/capsule-authoring.tsx",['assertCurrent','snapshot','publicationPayload','prepare','context'],'CapsuleAuthorEditor');

async function actualDraft(runtime,subjectId,key,initial){
 const draft=createGovernanceDraftState(runtime,subjectId,true,key,initial,error=>error.message);
 await draft.start();await draft.snapshot();
 return draft;
}
async function readHistory(client){
 let after;const rows=[],seen=new Set();
 do{const page=await client.history(after?{after}:{});rows.push(...page.items.filter(item=>item.kind==='case-history'));after=page.nextCursor;if(after){assert.ok(!seen.has(after));seen.add(after);}}while(after);
 return rows;
}
async function authorHarness(f,{key,initial,client=f.author.client,mode='author',detail=null,management=null,disclosure=null}={}){
 const {runtime,identity}=f.author,subjectId=identity.subjectId,draftKey=key??state.capsuleInputDraftKey(runtime.api.endpoint,subjectId,'test-author-'+randomUUID()),draft=await actualDraft(runtime,subjectId,draftKey,initial);
 draft.change(initial);await draft.snapshot();
 const history={items:await readHistory(client),load:async()=>{history.items=await readHistory(client);return history.items;}},source=history.items.find(item=>item.caseId===initial.form.caseId);
 const capture={preview:null,context:null,messages:[],checks:[]},draftRef={current:draft};
 const globals={...shared,...author,capsuleRefKey,currentCapsuleFacts,client,draft,draftRef,draftKey,initialValue:initial,history,source,subjectId,mode,detail,management,disclosure,
  lease:runtime.receiptStatus.captureLease(),epoch:{current:1},
  setCurrentManagement:value=>{capture.currentManagement=value;},setMessage:value=>capture.messages.push(value),setCheck:value=>capture.checks.push(value),setChecking:()=>{},
  propose:async(type,payload,scope,context)=>{capture.preview=await client.prepare(type,payload,scope);capture.context=context;}
 };
 const actions=compile(authorActions,globals,['snapshot','publicationPayload','prepare','context']);
 return{...capture,capture,...actions,draft,draftKey,runtime,subjectId,async save(){await actions.prepare();const receipt=await client.execute(capture.preview,{confirmed:true,onJournal:capture.context.onJournal});await capture.context.onAcknowledged(receipt);return receipt;}};
}
function filled(f,extras=[]){
 const value=author.capsuleAuthorInput({capsuleId:f.payload.capsuleId,version:f.payload},'revision',{revision:0,publishedVersionCount:0},{visibility:'Private',viewers:[]});
 value.form.sources=[...value.form.sources,...extras.map(shared.sourceLocator)];value.step=1;return value;
}
const businessCount=f=>f.requests.filter(request=>request.path==='/v2/capsules/events').length;

// These tests execute extracted current UI state/action functions against real
// local HTTP/OIDC/Ed25519 Consent/PGlite services. Draft state is the same store
// used by the React hook; this file does not claim browser/pixel coverage.
test('Capsule author UI input, source and exact receipt continuity', {timeout:180000}, async suite=>{
 const f=await capsuleWebContinuityFixture();
 try{
  const {runtime,identity}=f.author,subjectId=identity.subjectId,base=filled(f);
  await suite.test('legacy import preserves original bytes and only keeps body-free exact source choices',async()=>{
   const key=state.capsuleInputDraftKey(runtime.api.endpoint,subjectId,'author'),oldKey=state.capsuleAuthoringDraftKey(runtime.api.endpoint,subjectId,'author');
   const ref={kind:'selected-message',id:f.message.messageId,version:1},extra={ref,authorId:f.sourceAuthor.identity.subjectId,label:'PRIVATE SOURCE BODY',view:{text:'PRIVATE SOURCE BODY'}};
   const old={kind:'capsule-authoring-draft',mode:'author',form:{...base.form,sourceKeys:[capsuleRefKey(f.otherRef)],attributionKeys:[capsuleRefKey(f.otherRef)],extraSources:[extra],sourceRefs:[f.otherRef],attributionRefs:[{subjectId:f.sourceAuthor.identity.subjectId,source:f.otherRef}]},viewers:[f.sourceAuthor.identity.subjectId],step:3};
   await runtime.putLocal(oldKey,old,subjectId);const before=JSON.stringify(await runtime.getLocal(oldKey,subjectId));
   const normalize=saved=>author.migrateCapsuleAuthorInput(saved,'author',undefined,author.capsuleAuthorInput(null,'author'));
   await state.prepareCapsuleInput(runtime,runtime.receiptStatus.captureLease(),subjectId,key,[oldKey],normalize);
   const imported=await runtime.getLocal(key,subjectId);assert.equal(JSON.stringify(await runtime.getLocal(oldKey,subjectId)),before);assert.ok(imported.revision);assert.deepEqual(imported.value.form.sources.find(item=>item.ref.kind==='selected-message').ref,ref);assert.deepEqual(imported.value.form.sources.find(item=>item.ref.id===f.otherRef.id).ref,f.otherRef,'cross-case source retains its own exact caseId');assert.equal(JSON.stringify(imported.value).includes('PRIVATE SOURCE BODY'),false);assert.equal(imported.value.viewers[0],f.sourceAuthor.identity.subjectId);
   await runtime.updateLocal(key,()=>null,subjectId);
   await state.prepareCapsuleInput(runtime,runtime.receiptStatus.captureLease(),subjectId,key,[oldKey],normalize);
   assert.equal(await runtime.getLocal(key,subjectId),null,'durable marker prevents legacy resurrection');
   assert.equal(JSON.stringify(await runtime.getLocal(oldKey,subjectId)),before);
  });
  await suite.test('existing new draft wins a migration race and foreign mode stays separate',async()=>{
   const key=state.capsuleInputDraftKey(runtime.api.endpoint,subjectId,'migration-race'),saved={version:1,revision:randomUUID(),value:{text:'new page input'}};
   await runtime.putLocal(key,saved,subjectId);
   await state.prepareCapsuleInput(runtime,runtime.receiptStatus.captureLease(),subjectId,key,[],()=>{throw Error('must not import over current');});
   assert.deepEqual(await runtime.getLocal(key,subjectId),saved);
   assert.equal(author.migrateCapsuleAuthorInput({kind:'capsule-authoring-draft',mode:'revision',capsuleId:randomUUID(),form:base.form},'author',undefined,base),null);
  });
  await suite.test('one actual preview reads names, exact message and private license without signing or writing',async()=>{
   const sent=await runtime.chat.send(f.roomId,'[本地合成] 本人原话用于复核来源，不代表外部执行。',{confirmed:true}),ownRef={kind:'selected-message',id:sent.messageId,version:1},initial=filled(f,[{ref:ownRef,authorId:subjectId}]);
   const h=await authorHarness(f,{initial}),before=f.requests.length,posts=businessCount(f);
   await h.prepare();const preview=h.capture.preview,display=h.capture.context.display;
   assert.equal(preview.visibility,'Private');assert.deepEqual(preview.payload.permissionRefs,[f.permission.id]);assert.ok(preview.payload.attributionRefs.some(item=>item.source.id===ownRef.id&&item.subjectId===subjectId));
   assert.ok(display.sources.some(item=>item.ref.id===ownRef.id&&item.reading.text.includes('本人原话')));
   assert.equal(display.permissions[0].payload.allowPublic,false);
   assert.equal(businessCount(f),posts);assert.equal(f.requests.slice(before).some(request=>request.path==='/v1/consents'),false);
   assert.equal(JSON.stringify((await h.draft.snapshot()).value).includes('本人原话用于复核来源'),false,'read body never enters own draft');
   const grantReading=await shared.readCapsulePermissionSources(runtime,f.author.client,subjectId,[shared.sourceLocator({ref:ownRef,authorId:subjectId})],[]);
   assert.equal(grantReading[0].ref.version,1);assert.ok(grantReading[0].reading.text.includes('本人原话'));assert.equal(grantReading[0].reading.publicationPermission,false);
  });
  await suite.test('private permission does not silently become public and inputs stay intact',async()=>{
   const initial=structuredClone(base);initial.form.visibility='Public';const h=await authorHarness(f,{initial}),before=businessCount(f),saved=await h.draft.snapshot();
   await assert.rejects(()=>h.prepare(),/许可|范围/);assert.equal(h.capture.preview,null);assert.equal(businessCount(f),before);assert.deepEqual((await h.draft.snapshot()).value,saved.value);assert.ok(h.capture.checks.some(value=>value?.readyForPublication===false));
  });
  await suite.test('one save has one business POST and clears only its matching CAS draft',async()=>{
   const h=await authorHarness(f,{initial:structuredClone(base)}),before=businessCount(f),receipt=await h.save();
   assert.equal(receipt.state,'acknowledged');assert.equal(businessCount(f),before+1);assert.equal(await runtime.getLocal(h.draftKey,subjectId),null);
   const read=await f.author.client.get({capsuleId:h.capture.preview.payload.capsuleId,versionId:h.capture.preview.payload.id});assert.equal(read.version.title,base.form.title);
  });
  await suite.test('lost ACK resumes original operation after refresh without another publication POST',async()=>{
   const h=await authorHarness(f,{initial:structuredClone(base)});await h.prepare();const before=businessCount(f),originalId=h.capture.preview.operationId;
   f.hooks.afterResponse=async(path,response)=>{if(path==='/v2/capsules/events'&&response.ok){delete f.hooks.afterResponse;throw Error('explicit synthetic ACK loss after actual service acceptance');}};
   await assert.rejects(()=>f.author.client.execute(h.capture.preview,{confirmed:true,onJournal:h.capture.context.onJournal}),/synthetic ACK loss/);
   const stored=await runtime.getLocal(h.draftKey,subjectId);assert.equal(stored.attempt.operationId,originalId);assert.ok(stored.attempt.payloadHash);
   const restored=createCapsuleWebClient(f.author.clientOptions),receipt=await restored.resumePending();assert.equal(receipt.state,'acknowledged');assert.equal(receipt.operationId,originalId);
   assert.equal(await state.settleCapsuleInput(runtime,subjectId,h.draftKey,restored,receipt),true);assert.equal(await runtime.getLocal(h.draftKey,subjectId),null);assert.equal(businessCount(f),before+1);
  });
  await suite.test('an old ACK cannot erase later input and CAS refuses a competing page overwrite',async()=>{
   const h=await authorHarness(f,{initial:structuredClone(base)});await h.prepare();
   f.hooks.afterResponse=async(path,response)=>{if(path==='/v2/capsules/events'&&response.ok){delete f.hooks.afterResponse;throw Error('explicit synthetic ACK loss');}};
   await assert.rejects(()=>f.author.client.execute(h.capture.preview,{confirmed:true,onJournal:h.capture.context.onJournal}),/synthetic ACK loss/);
   const newer={...base,form:{...base.form,title:'later own input survives'}};
   h.draft.change(newer);await h.draft.snapshot();const receipt=await f.author.client.resumePending();assert.equal(receipt.state,'acknowledged');
   await h.capture.context.onAcknowledged(receipt);assert.equal((await runtime.getLocal(h.draftKey,subjectId)).value.form.title,newer.form.title);
   const other=await actualDraft(runtime,subjectId,h.draftKey,base);other.change({form:{...base.form,title:'competing page input'}});await other.snapshot();
   h.draft.change({form:{...base.form,title:'locally retained stale page input'}});await assert.rejects(()=>h.draft.snapshot(),/另一页|草稿/);
   assert.equal((await runtime.getLocal(h.draftKey,subjectId)).value.form.title,'competing page input');
  });
  await suite.test('permission revoked after preview preserves input and blocks automatic retry of rejection',async()=>{
   const h=await authorHarness(f,{initial:structuredClone(base)});await h.prepare();const operationId=h.capture.preview.operationId,hash=h.capture.preview.payloadHash;
   await f.sourceAuthor.write('/v2/capsules/permissions',{schemaVersion:2,id:randomUUID(),kind:'revoke',permissionId:f.permission.id,reason:'本地合成验证：预览后原作者撤销许可。'},'capsule.permission',{viewers:[subjectId]});
   const before=businessCount(f);await assert.rejects(()=>f.author.client.execute(h.capture.preview,{confirmed:true,onJournal:h.capture.context.onJournal}));
   const stored=await runtime.getLocal(h.draftKey,subjectId);assert.equal(stored.attempt.operationId,operationId);assert.equal(stored.attempt.payloadHash,hash);assert.equal(stored.value.form.title,base.form.title);
   const after=businessCount(f),receipt=await f.author.client.resumePending();assert.equal(after,before+1);assert.equal(receipt.reason,'business-rejected');assert.equal(businessCount(f),after);
   assert.equal(await state.settleCapsuleInput(runtime,subjectId,h.draftKey,f.author.client,receipt),false);
   await f.author.client.stopLocalRetry(operationId,{confirmed:true});
  });
  await suite.test('same owner reconnect invalidates the old draft lease before any overwrite',async()=>{
   const key=state.capsuleInputDraftKey(runtime.api.endpoint,subjectId,'rebind-test'),draft=await actualDraft(runtime,subjectId,key,base);draft.change(base);await draft.snapshot();const before=JSON.stringify(await runtime.getLocal(key,subjectId)),binding=runtime.api.snapshot().bindingId;
   await runtime.connect({confirmed:true});assert.notEqual(runtime.api.snapshot().bindingId,binding);
   draft.change({form:{...base.form,title:'must remain local only'}});await assert.rejects(()=>draft.snapshot(),/authority_changed|草稿|身份/);assert.equal(JSON.stringify(await runtime.getLocal(key,subjectId)),before);
  });
 }finally{delete f.hooks.afterResponse;await f.close();}
});
