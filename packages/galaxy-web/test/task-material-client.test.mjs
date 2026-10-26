import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createTaskMaterialClient,materialTaskText,adoptPreparedTaskMaterials,literalTaskText,replaceLiteralTaskText,
  localTaskTextView,withholdTaskMaterialTree,withholdTaskMaterialProjection,independentTaskLabel,taskMaterialProjectionKey,taskMaterialDerivedView} from "../src/features/tasks/materials/task-material-client.mjs";
import {taskDraft,publicationFromDraft} from "../src/features/tasks/task-bounty-client.mjs";
import {createTaskPreparationClient} from "../src/features/tasks/publish/task-preparation-client.mjs";
import {createHelpOriginClient} from "../src/features/help-search/help-origin-client.mjs";
const hash=text=>createHash('sha256').update(text).digest('hex');
function fixture(){
 const now={value:100},scope={key:'A:binding:1',subjectId:'GUID1000000000000000000000000000'}, endpoint='https://official.example.org';
 const materialId=randomUUID(),raw='ab😀源段cd', selected='😀源', edited='已编辑的来源片段';
 const descriptor={materialId,source:{kind:'forum-post-version',endpoint,postId:randomUUID(),versionId:randomUUID(),permissionId:randomUUID(),
  payloadHash:hash('exact source payload'),field:'body',start:2,end:4,selectionHash:hash(selected)},textHash:hash(edited),purpose:'task-context',expiresAt:250};
 const version={availability:'available',authorId:scope.subjectId,permissionId:descriptor.source.permissionId,publishedUntil:300,
  authorizationEvidence:{intent:{payloadHash:descriptor.source.payloadHash}},payload:{title:'source title',body:raw}};
 /** @type {{version:typeof version,permission:{stoppedReasons:string[]},wait:Promise<void>|null}} */
 const controls={version,permission:{stoppedReasons:[]},wait:null};const initial=scope.key;
 const runtime={taskDraftScope:()=>({...scope}),receiptStatus:{captureLease:()=>({assertCurrent(){if(scope.key!==initial)throw Error('lease changed');}})},
  api:{endpoint,snapshot:()=>({subjectId:scope.subjectId}),async call(path){if(path.includes('/permissions/'))return structuredClone(controls.permission);
   const value=structuredClone(controls.version);if(controls.wait)await controls.wait;return value;}}};
 const client=createTaskMaterialClient(runtime,{now:()=>now.value});
 const draft={title:'独立标题',summary:{format:'task-text-v1',segments:[{kind:'literal',text:'原有独立说明\n'},{kind:'material',materialId}]},
  materials:[descriptor],materialBodies:[{materialId,text:edited}]};
 return{client,runtime,scope,controls,now,descriptor,draft,edited};
}
test('edited material remains bound to exact Unicode source selection and is never converted to literal',async()=>{
 const f=fixture(),result=await f.client.sanitize(f.draft,{validateBodyHash:true});
 assert.equal(result.states[f.descriptor.materialId].status,'available');
 assert.equal(localTaskTextView(result.view.summary,result.view.materialBodies,result.states,100).text,'原有独立说明\n'+f.edited);
 const edited=replaceLiteralTaskText(result.value.summary,'新的独立说明\n');
 assert.equal(literalTaskText(edited),'新的独立说明\n');assert.deepEqual(edited.segments.at(-1),{kind:'material',materialId:f.descriptor.materialId});
 f.controls.version.payload.body='ab😀另段cd';const changed=await f.client.sanitize(f.draft);
 assert.equal(changed.states[f.descriptor.materialId].status,'unavailable');assert.equal(changed.view.materialBodies.length,0);
 assert.equal(changed.value.materialBodies[0].text,f.edited);assert.equal(changed.erased.length,0);f.client.close();
});
test('temporary source uncertainty hides the derived body but preserves independently edited text and exact body',async()=>{
 const f=fixture();f.controls.version={availability:'unavailable'};f.controls.permission.stoppedReasons=['historical-cause-unavailable'];
 const result=await f.client.sanitize(f.draft);assert.deepEqual(result.erased,[]);assert.deepEqual(result.value.materialBodies,f.draft.materialBodies);
 assert.equal(result.view.materialBodies.length,0);assert.equal(localTaskTextView(result.view.summary,result.view.materialBodies,result.states,100).text,'原有独立说明\n');
 f.client.close();
});
test('permanent withdrawal takes precedence over pending/unknown causes and erases only sidecar',async()=>{
 const f=fixture();f.controls.version={availability:'unavailable'};f.controls.permission.stoppedReasons=['deletion-pending','historical-cause-unavailable','consent-revoked'];
 const original=JSON.stringify(f.draft.materials),result=await f.client.sanitize(f.draft);
 assert.deepEqual(result.erased,[f.descriptor.materialId]);assert.equal(result.value.materialBodies.length,0);
 assert.equal(JSON.stringify(result.value.materials),original);assert.equal(literalTaskText(result.value.summary),'原有独立说明\n');f.client.close();
});
test('material expiry preserves original descriptor and independent text while eliminating material display and body',async()=>{
 const f=fixture();f.now.value=251;const result=await f.client.sanitize(f.draft,{rebuild:true});
 assert.equal(result.value.materialBodies.length,0);assert.equal(result.view.materialBodies.length,0);assert.deepEqual(result.value.materials,f.draft.materials);
 assert.equal(localTaskTextView(result.view.summary,result.view.materialBodies,result.states,251).state,'partial');f.client.close();
});
test('established permission evidence or audience mismatch erases a local copy while permission uncertainty retains it',async()=>{
 for(const reason of ['permission-evidence-mismatch','audience-mismatch','permission-unavailable']){
  const f=fixture();f.controls.version={availability:'unavailable'};f.controls.permission.stoppedReasons=['historical-cause-unavailable',reason];
  const result=await f.client.sanitize(f.draft),permanent=reason!=='permission-unavailable';
  assert.equal(result.view.materialBodies.length,0);assert.equal(result.value.materialBodies.length,permanent?0:1);
  assert.deepEqual(result.erased,permanent?[f.descriptor.materialId]:[]);assert.deepEqual(result.value.materials,f.draft.materials);
  assert.equal(literalTaskText(result.value.summary),'原有独立说明\n');f.client.close();
 }
});
test('delayed source response cannot cross a same-identity connection lifecycle',async()=>{
 const f=fixture();let release;f.controls.wait=new Promise(resolve=>{release=resolve;});const pending=f.client.sanitize(f.draft);
 f.scope.key='A:binding:2';release();await assert.rejects(pending,/身份、服务或页面已改变/);f.client.close();
});
test('summary append and selected title satisfy an empty request without placing selected text inside signed root',()=>{
 const f=fixture(),titleId=randomUUID(),descriptors=[{...f.descriptor,materialId:titleId,source:{...f.descriptor.source,field:'title',start:0,end:1},textHash:hash('源标题')},f.descriptor];
 const original=taskDraft({title:'独立旧标题',summary:'独立旧说明'}),prepared={descriptors,materialBodies:[{materialId:titleId,text:'源标题'},...f.draft.materialBodies]};
 const adopted=adoptPreparedTaskMaterials(original,prepared,{useTitle:true,useBody:true,summaryMode:'append',visibility:'Private',titleId,bodyId:f.descriptor.materialId});
 assert.equal(adopted.materialRestore.title,'独立旧标题');assert.equal(literalTaskText(adopted.summary),'独立旧说明\n\n');
 const empty=adoptPreparedTaskMaterials(taskDraft(),prepared,{useTitle:true,useBody:true,summaryMode:'replace',visibility:'Private',titleId,bodyId:f.descriptor.materialId});
 const root=publicationFromDraft(empty,[],100);
 assert.deepEqual(root.title,materialTaskText(titleId));assert.deepEqual(root.workContext.goal,root.title);assert.deepEqual(root.summary,root.workContext.currentSituation);
 assert.equal(JSON.stringify(root).includes('源标题'),false);assert.equal(JSON.stringify(root).includes(f.edited),false);
});
const field=(text,id,until=200,literal='')=>({state:'available',text:literal+text,checkedAt:100,availableUntil:until,segments:[...(literal?[{kind:'literal',text:literal}]:[]),{kind:'material',materialId:id,status:'available',text}]});
test('History, nested collaborations, notification and search raw projections lose every expired controlled copy',()=>{
 const id=randomUUID(),mid=randomUUID(),title='受控标题',body='受控正文',fields={title:field(title,mid),summary:field(body,mid,200,'独立说明')};
 const task={taskId:id,request:{title,summary:'独立说明'+body,workContext:{}},textView:{format:'task-text-view-v1',fields,materials:[]}};
 const history={kind:'task-history',taskId:id,title,summary:'独立说明'+body,textView:{format:'task-text-view-v1',fields}};
 const tree={case:{title:'独立案例标题',collaborations:[history]},search:{type:'history',title,summary:'独立说明'+body,record:history,textView:history.textView},
  notice:{title,object:{type:'task',id},textView:{title:fields.title}},task};
 const safe=withholdTaskMaterialTree(tree,201);
 assert.equal(JSON.stringify(safe).includes(title),false);assert.equal(JSON.stringify(safe).includes(body),false);
 assert.equal(safe.case.title,'独立案例标题');assert.equal(safe.case.collaborations[0].summary,'独立说明');
 assert.equal(safe.notice.title,'来源标题当前不可用');assert.equal(safe.task.request.summary,'独立说明');
 const denied=withholdTaskMaterialTree(tree,150,{current:new Map([[id,null]])});
 assert.equal(JSON.stringify(denied).includes(body),false);assert.equal(JSON.stringify(denied).includes(title),false);
});
test('current Task fields replace older task-history/notification copies without editing immutable root',()=>{
 const id=randomUUID(),mid=randomUUID(),old={kind:'task-history',taskId:id,title:'旧的材料投影',summary:'旧说明',textView:{fields:{title:field('旧的材料投影',mid),summary:field('旧说明',mid)}}};
 const current={taskId:id,request:{title:'',summary:'独立'},rootRequest:{title:materialTaskText(mid)},textView:{fields:{
  title:{state:'unavailable',text:'',segments:[{kind:'material',materialId:mid,status:'unavailable'}]},
  summary:{state:'partial',text:'独立',segments:[{kind:'literal',text:'独立'},{kind:'material',materialId:mid,status:'unavailable'}]}},materials:[]}};
 const safe=withholdTaskMaterialTree(old,150,{current:new Map([[id,current]])});
 assert.equal(safe.title,'来源标题当前不可用');assert.equal(safe.summary,'独立');assert.equal(JSON.stringify(safe).includes('旧的材料投影'),false);
 const projected=withholdTaskMaterialProjection(current,150);assert.deepEqual(projected.rootRequest,current.rootRequest);
 assert.equal(independentTaskLabel(current),'关联任务 '+id);
});
test('saved preparation strips every controlled Task source body while preserving independent candidate notes and locators',async()=>{
 const taskId=randomUUID(),mid=randomUUID(),owner={subjectId:'GUID1000000000000000000000000000',bindingId:randomUUID(),generation:1},endpoint='https://official.example.org';
 const source={type:'history',title:'待清理的来源标题',summary:'独立说明来源正文',ref:{id:taskId,version:'1'},record:{kind:'task-history',taskId},
  textView:{fields:{title:field('待清理的来源标题',mid),summary:field('来源正文',mid,200,'独立说明')}}};
 const saved=new Map(),runtime={api:{endpoint,snapshot:()=>owner},getLocal:async key=>saved.get(key),putLocal:async(key,value)=>saved.set(key,value)};
 const client=createTaskPreparationClient(runtime),payload={title:materialTaskText(mid),operationId:randomUUID(),taskId};
 await client.freeze(payload,{ownerId:owner.subjectId,endpoint,input:{keyword:'独立检索词'},pages:[{items:[source]}],candidates:[{help:'独立协助意图',basis:'独立依据',sources:[{item:source}]}]});
 const encoded=JSON.stringify([...saved.values()]);assert.equal(encoded.includes('待清理的来源标题'),false);assert.equal(encoded.includes('来源正文'),false);
 assert.ok(encoded.includes('独立说明'));assert.ok(encoded.includes('独立协助意图'));assert.ok(encoded.includes(taskId));client.close();
});
test('original-work client returns a neutral locator title instead of copying controlled Task material into Capsule context',async()=>{
 const taskId=randomUUID(),mid=randomUUID(),owner={subjectId:'GUID1000000000000000000000000000',bindingId:randomUUID(),generation:1},endpoint='https://official.example.org';
 const source={taskId,schemaVersion:2,requesterId:owner.subjectId,caseId:null,request:{title:'来源标题',summary:'来源说明',workContext:{}},
  rootRequest:{title:materialTaskText(mid)},textView:{fields:{title:field('来源标题',mid),summary:field('来源说明',mid)}}};
 const runtime={api:{endpoint,snapshot:()=>owner,call:async()=>source},receiptStatus:{captureLease:()=>({subjectId:owner.subjectId,assertCurrent(){}})}};
 const client=createHelpOriginClient(runtime),result=await client.read(taskId);
 assert.equal(result.task.request.title,'原任务 '+taskId);assert.equal(result.task.request.summary,'');assert.equal(JSON.stringify(result).includes('来源说明'),false);
 assert.equal(JSON.stringify(result).includes('来源标题'),false);client.close();
});


test('limited contribution rechecks cannot borrow a complete Task read or add unselected fields',()=>{
 const materialId=randomUUID(),taskId=randomUUID(),source={kind:'task-event',id:randomUUID(),eventVersion:1,payloadHash:hash('root')};
 const field={text:'Controlled limited title',state:'available',availableUntil:200,segments:[{kind:'material',materialId,status:'available',text:'Controlled limited title'}]};
 const limited={title:field.text,textView:{format:'task-text-view-v1',checkedAt:100,fields:{title:field}}};
 Object.defineProperties(limited,{_webTaskScope:{value:'current'},_webTaskRead:{value:{source,purpose:'honor'}}});
 const broader={taskId,request:{title:'A broader Task title',summary:'Unselected summary',workContext:{}},textView:{fields:{title:{...field,text:'A broader Task title'},summary:{text:'Unselected summary',state:'available',segments:[{kind:'literal',text:'Unselected summary'}]}},materials:[]}};
 const rejected=withholdTaskMaterialTree(limited,100,{current:new Map([[taskId,broader]])});
 assert.equal(rejected.title,'来源标题当前不可用');assert.equal(JSON.stringify(rejected).includes('Controlled limited title'),false);
 const current={title:'Fresh limited title',summary:'Still not selected',textView:{fields:{title:{...field,text:'Fresh limited title',segments:[{kind:'material',materialId,status:'available',text:'Fresh limited title'}]},summary:broader.textView.fields.summary}}};
 const key=taskMaterialProjectionKey(limited),visible=withholdTaskMaterialTree(limited,100,{current:new Map([[key,current]])});
 assert.equal(visible.title,'Fresh limited title');assert.equal(visible.summary,undefined);assert.equal(visible.taskId,undefined);
 assert.deepEqual(Object.keys(visible.textView.fields),['title']);assert.equal(visible._webTaskRead.source.id,source.id);
 assert.equal(JSON.stringify(visible).includes('Still not selected'),false);assert.equal(taskMaterialProjectionKey(visible),key);
 const removed=withholdTaskMaterialTree(limited,100,{current:new Map([[key,{textView:{fields:{}}}]])});
 assert.equal(JSON.stringify(removed).includes('Controlled limited title'),false);
 const expired=withholdTaskMaterialTree(visible,201);assert.equal(expired.title,'来源标题当前不可用');
});

test('small derived reading views retain material authority without copying unselected body or signed root',()=>{
 const taskId=randomUUID(),materialId=randomUUID(),title={state:'available',text:'Bound title',availableUntil:150,segments:[{kind:'material',materialId,status:'available',text:'Bound title'}]};
 const task={taskId,rootRequest:{title:materialTaskText(materialId)},request:{title:'Bound title'},textView:{format:'task-text-view-v1',checkedAt:100,fields:{title,summary:{text:'Not selected',segments:[{kind:'literal',text:'Not selected'}]}},materials:[{locator:{taskId,materialId},text:'Not selected material body'}]}};
 Object.defineProperty(task,'_webTaskScope',{value:'current'});
 const view=taskMaterialDerivedView(task,{kind:'task',title:'Bound title'});
 assert.equal(view._webTaskId,taskId);assert.equal(view._webTaskScope,'current');assert.equal(view.rootRequest,undefined);assert.equal(view.request,undefined);
 assert.equal(JSON.stringify(view).includes('Not selected'),false);
 assert.equal(withholdTaskMaterialTree(view,151).title,'来源标题当前不可用');
});
