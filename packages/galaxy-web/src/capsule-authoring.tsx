import React,{useEffect,useId,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {memberName} from './conversation-ui';
import {capsuleRefKey,currentCapsuleFacts} from './capsule-workspace-client.mjs';
import {CapsuleMessagePicker} from './capsule-source-picker';
import {ConfigurationPicker} from './configuration-picker';
import {useGovernanceDraft} from './governance-presentation';
import {CapsuleInputGate,capsuleAuthoringDraftKey,capsuleInputDraftKey} from './capsule-authoring-state';
import {PeopleSelection,SourceReading,WorkSelection,methodInputError,readableCaseSources,sourceLocator,uniqueSources,useCapsulePeople,useCapsuleWorkHistory,useRegisteredCapsuleDraft,workPeople} from './capsule-authoring-shared';
import type {CapsuleAuthorForm,CapsuleAuthorInput,CapsuleAuthoringProps,CapsuleAuthorMode,CapsuleDetail,CapsuleDisclosure,CapsuleLocator,CapsuleManagement,CapsulePreviewContext,CapsulePreviewDisplay,CapsulePublication,CapsulePublicationCheck,CapsuleSourceItem,CapsuleSourceRef,CapsuleVersion} from './capsule-authoring-types';
import './capsule-authoring.css';
export {capsuleAuthoringDraftKey} from './capsule-authoring-state';
export {CapsulePermissionWorkspace} from './capsule-permission-workspace';

const textLines=(value:string)=>value.split('\n').map(line=>line.trim()).filter(Boolean);
const factKey=(value:{id:string;version:number})=>value.id+':'+value.version;
const blank=():CapsuleAuthorForm=>({title:'',problemPattern:'',environmentName:'',environmentVersion:'',solutionStrategy:'',tools:'',skills:'',mcpRefs:'',verificationMethod:'',limitations:'',capabilityId:'',applicableScope:'',license:'',visibility:'Private',caseId:'',resultKey:'',sources:[],permissionIds:[],contributorIds:[],externalReferences:[]});
function referenceFromKey(key:string,caseId:string):CapsuleSourceRef{
 const [kind,id,version]=key.split(':'),number=Number(version);
 if(id&&Number.isInteger(number)&&number>0){
  if(kind==='configuration'||kind==='selected-message')return{kind,id,version:number};
  if(caseId&&(kind==='case-root'||kind==='attempt'||kind==='intervention'||kind==='result'||kind==='evidence'||kind==='verification'||kind==='outcome-material'))return{kind,id,version:number,caseId};
 }
 throw Error('旧草稿有一条来源格式暂不能核对，原内容仍保留。');
}
export function capsuleAuthorInput(detail:CapsuleDetail|null,mode:CapsuleAuthorMode,management:CapsuleManagement|null=null,disclosure:CapsuleDisclosure|null=null):CapsuleAuthorInput{
 const version=mode==='revision'?detail?.version:null,form=blank();
 if(version){
  for(const key of ['title','problemPattern','solutionStrategy','verificationMethod','capabilityId','applicableScope','license'] as const)form[key]=version[key]??'';
  for(const key of ['tools','skills','mcpRefs','limitations'] as const)form[key]=(version[key]??[]).join('\n');
  form.environmentName=version.environment.name;form.environmentVersion=version.environment.version;form.caseId=version.sourceResolution.caseId;form.resultKey=version.sourceResolution.resultId+':'+('resultVersion' in version.sourceResolution?version.sourceResolution.resultVersion:1);
  const attributions=version.attributionRefs??[],sources=version.sourceRefs??[];
  const authors=new Map(attributions.map(item=>[capsuleRefKey(item.source),item.subjectId]));
  form.sources=uniqueSources([...sources,...attributions.map(item=>item.source)].map(ref=>{const authorId=authors.get(capsuleRefKey(ref));return sourceLocator({ref,...(authorId?{authorId}:{})});}));
  form.permissionIds=version.permissionRefs??[];form.contributorIds=version.contributors;form.externalReferences=version.externalReferences??[];
 }
 form.visibility=disclosure?.visibility??'Private';
 return{form,viewers:disclosure?.viewers??[],step:0,externalInput:{url:'',description:'',license:''},expectedRevision:management?.revision??0,maintenance:detail?.securityIssue?'resolve-security':detail?.deprecated?'security-issue':'deprecate',summary:'',replacement:''};
}
export function migrateCapsuleAuthorInput(saved:unknown,mode:CapsuleAuthorMode,id:string|undefined,initial:CapsuleAuthorInput):CapsuleAuthorInput|null{
 const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
 if(!record(saved)||!record(saved.form)||saved.kind&&saved.kind!=='capsule-authoring-draft'||saved.mode&&saved.mode!==mode||mode==='revision'&&saved.capsuleId!==id)return null;
 const invalid=()=>Error('旧草稿格式暂不能核对，原内容仍保留。');
 const list=(value:unknown):unknown[]=>{if(value===undefined||value===null)return[];if(!Array.isArray(value))throw invalid();return value;};
 const text=(value:unknown):string=>{if(typeof value!=='string')throw invalid();return value;};
 const strings=(value:unknown)=>list(value).map(text),old=saved.form,form={...initial.form};
 for(const key of ['title','problemPattern','environmentName','environmentVersion','solutionStrategy','tools','skills','mcpRefs','verificationMethod','limitations','capabilityId','applicableScope','license','caseId','resultKey'] as const)
  if(old[key]!==undefined)form[key]=text(old[key]);
 if(old.visibility!==undefined){if(old.visibility!=='Private'&&old.visibility!=='Public')throw invalid();form.visibility=old.visibility;}
 const reference=(value:unknown):CapsuleSourceRef=>{
  if(!record(value)||typeof value.kind!=='string'||typeof value.id!=='string'||typeof value.version!=='number')throw invalid();
  return referenceFromKey(value.kind+':'+value.id+':'+value.version,typeof value.caseId==='string'?value.caseId:form.caseId);
 };
 const source=(value:unknown):CapsuleSourceItem=>{
  if(!record(value))throw invalid();const ref=reference(value.ref);
  return sourceLocator({ref,...(value.authorId!==undefined&&value.authorId!==null?{authorId:text(value.authorId)}:{})});
 };
 const attributions=list(old.attributionRefs).map(value=>{if(!record(value))throw invalid();return{subjectId:text(value.subjectId),source:reference(value.source)};});
 const known=list(old.extraSources).map(source),selected=list(old.sources).map(source);
 const exact=[...list(old.sourceRefs).map(reference),...attributions.map(item=>item.source),...selected.map(item=>item.ref),...known.map(item=>item.ref)];
 const refs=[...exact,...[...new Set([...strings(old.sourceKeys),...strings(old.attributionKeys)])].map(key=>exact.find(ref=>capsuleRefKey(ref)===key)??referenceFromKey(key,form.caseId))];
 form.sources=uniqueSources([...selected,...refs.map(ref=>({ref,authorId:known.find(item=>capsuleRefKey(item.ref)===capsuleRefKey(ref))?.authorId??attributions.find(item=>capsuleRefKey(item.source)===capsuleRefKey(ref))?.subjectId})),...known].map(sourceLocator));
 form.permissionIds=strings(old.permissionIds??old.permissionRefs);form.contributorIds=old.contributorIds!==undefined||old.contributors!==undefined?strings(old.contributorIds??old.contributors):initial.form.contributorIds;
 if(old.externalReferences!==undefined)form.externalReferences=list(old.externalReferences).map(value=>{
  if(!record(value)||value.inclusion!=='reference-only; no-imported-body'||value.license!==null&&typeof value.license!=='string')throw invalid();
  return{url:text(value.url),description:text(value.description),license:value.license,inclusion:value.inclusion};
 });
 const step=saved.step??0;if(typeof step!=='number'||!Number.isFinite(step))throw invalid();
 return{...initial,form,viewers:saved.viewers!==undefined?strings(saved.viewers):initial.viewers,step:Math.min(1,Math.max(0,step))};
}
export function CapsuleAuthoring(props:CapsuleAuthoringProps){
 const {runtime,subjectId,mode,detail,management,disclosure}=props,identity=mode==='maintenance'?detail?.versionId??undefined:mode==='revision'?detail?.capsuleId:undefined;
 const draftKey=capsuleInputDraftKey(runtime.api.endpoint,subjectId,mode,identity),initial=capsuleAuthorInput(detail,mode,management??null,disclosure??null);
 return <CapsuleInputGate {...{runtime,subjectId,draftKey}} legacyKeys={mode==='maintenance'?[]:[capsuleAuthoringDraftKey(runtime.api.endpoint,subjectId,mode,detail?.capsuleId),'capsule-draft:'+runtime.api.endpoint+':'+subjectId]} normalize={saved=>migrateCapsuleAuthorInput(saved,mode,detail?.capsuleId,initial)}>
  <CapsuleAuthorEditor {...props} {...{draftKey,initial}}/>
 </CapsuleInputGate>;
}
type FormTextKey=Exclude<{[K in keyof CapsuleAuthorForm]:CapsuleAuthorForm[K] extends string?K:never}[keyof CapsuleAuthorForm],'visibility'>;
function CapsuleAuthorEditor({runtime,client,subjectId,busy,run,propose,navigate,mode,detail,management,disclosure,versionOptions=[],draftKey,initial,registerDraft}:CapsuleAuthoringProps&{draftKey:string;initial:CapsuleAuthorInput}){
 const [initialValue]=useState(()=>initial),draft=useGovernanceDraft<CapsuleAuthorInput,CapsuleLocator>(runtime,subjectId,true,draftKey,initialValue),draftRef=useRegisteredCapsuleDraft(draft,draftKey,client,registerDraft);
 const lease=useMemo(()=>{const owner=runtime.receiptStatus.captureLease();if(owner.subjectId!==subjectId)throw Error('身份或连接已改变，请重新打开原稿。');return owner;},[runtime,subjectId]),epoch=useRef(0);
 useEffect(()=>{const view=epoch;view.current++;return()=>{view.current++;};},[]);
 function assertCurrent(token:number){lease.assertCurrent();if(token!==epoch.current)throw Error('页面或身份已改变，原输入仍保留。');}
 const input={...initialValue,...draft.value},form={...initialValue.form,...input.form},history=useCapsuleWorkHistory(client,form.caseId,busy),source=history.items.find(item=>item.caseId===form.caseId);
 const [check,setCheck]=useState<CapsulePublicationCheck|null>(null),[message,setMessage]=useState(''),[checking,setChecking]=useState(false),[currentManagement,setCurrentManagement]=useState<CapsuleManagement|null>(null),fieldId=useId(),top=useRef<HTMLElement>(null);
 const caseSources=readableCaseSources(source,form.sources),mainResults=currentCapsuleFacts(source?.results??[]).filter(item=>item.reportedOutcome==='succeeded'),result=mainResults.find(item=>factKey(item)===form.resultKey),main=result?caseSources.find(item=>item.ref.kind==='result'&&item.ref.id===result.id&&item.ref.version===result.version):null;
 const related=[...workPeople(source),...form.sources.map(item=>item.authorId),...form.contributorIds,...input.viewers,...(check?.sourceCoverage?.dependencies??[]).map(item=>item.authorId)],people=useCapsulePeople(runtime,subjectId,related);
 const currentSelected=form.sources.map(item=>caseSources.find(current=>capsuleRefKey(current.ref)===capsuleRefKey(item.ref))??(check?.sourceCoverage?.sources??[]).find(current=>capsuleRefKey(current.ref)===capsuleRefKey(item.ref))??item);
 const selectedKeys=new Set(form.sources.map(item=>capsuleRefKey(item.ref))),extraSources=form.sources.filter(item=>['configuration','selected-message'].includes(item.ref.kind));
 function change(patch:Partial<CapsuleAuthorInput>){draft.change(patch);setMessage('');setCheck(null);setCurrentManagement(null);}
 function fieldChange<K extends keyof CapsuleAuthorForm>(key:K,value:CapsuleAuthorForm[K]){change({form:{...form,[key]:value}});}
 function chooseExtra(items:CapsuleSourceItem[]){const other=form.sources.filter(item=>!['configuration','selected-message'].includes(item.ref.kind));fieldChange('sources',uniqueSources([...other,...items.map(sourceLocator)]));}
 function chooseSource(item:CapsuleSourceItem,chosen:boolean){const rest=form.sources.filter(current=>capsuleRefKey(current.ref)!==capsuleRefKey(item.ref));fieldChange('sources',chosen?[...rest,sourceLocator(item)]:rest);}
 async function snapshot(){const token=epoch.current;assertCurrent(token);let saved=await draft.snapshot();assertCurrent(token);if(!saved.revision){draft.change(saved.value);saved=await draft.snapshot();assertCurrent(token);}return saved;}
 async function publicationPayload(chosen:CapsuleAuthorInput,token:number):Promise<CapsuleVersion>{
  assertCurrent(token);const chosenForm=chosen.form;
  if(textLines(chosenForm.limitations).length>8)throw Error('限制最多填写八项，请合并相同含义的说明。');
  if(textLines(chosenForm.limitations).some(line=>line.length>1200))throw Error('每项限制最多一千二百字，请简要说明适用边界。');
  if((['tools','skills','mcpRefs'] as const).some(key=>textLines(chosenForm[key]).length>16||textLines(chosenForm[key]).some(line=>line.length>160)))throw Error('每类工具最多十六项，每项最多一百六十字。');
  const rows=await history.load();assertCurrent(token);const fresh=(rows??history.items).find(item=>item.caseId===chosenForm.caseId);
  if(!fresh)throw Error('所选工作当前不可读取。原输入和引用仍保留，请重新核对。');
  const actualResult=currentCapsuleFacts(fresh.results??[]).find(item=>factKey(item)===chosenForm.resultKey&&item.reportedOutcome==='succeeded');
  if(!actualResult)throw Error('所选结果当前不能支持新方法。请核对原结果或选择明确报告达到目标的当前版本。');
  let revision=0,version=1;
  if(mode==='revision'){
   if(!detail)throw Error('当前未取得本人版本管理状态，原稿仍保留。');
   const current=await client.versions({capsuleId:detail.capsuleId,limit:1});assertCurrent(token);
   if(!current.management)throw Error('当前未取得本人版本管理状态，原稿仍保留。');
   if(current.management.revision!==chosen.expectedRevision){setCurrentManagement(current.management);throw Error('这份方法已有更新。请核对当前管理状态，再决定用原输入整理新版本。');}
   revision=current.management.revision;version=current.management.publishedVersionCount+1;
  }
  const sources=readableCaseSources(fresh,chosenForm.sources),mainSource=sources.find(item=>item.ref.kind==='result'&&item.ref.id===actualResult.id&&item.ref.version===actualResult.version);
  const selected=uniqueSources([...chosenForm.sources.map(item=>sources.find(current=>capsuleRefKey(current.ref)===capsuleRefKey(item.ref))??item),...(mainSource?[mainSource]:[])]);
  const attributed=selected.filter((item):item is CapsuleSourceItem&{authorId:string}=>typeof item.authorId==='string'&&!!item.authorId);
  return{schemaVersion:2,id:crypto.randomUUID(),capsuleId:mode==='revision'&&detail?detail.capsuleId:crypto.randomUUID(),kind:'version',expectedRevision:revision,version,title:chosenForm.title,problemPattern:chosenForm.problemPattern,environment:{name:chosenForm.environmentName,version:chosenForm.environmentVersion},solutionStrategy:chosenForm.solutionStrategy,tools:textLines(chosenForm.tools),skills:textLines(chosenForm.skills),mcpRefs:textLines(chosenForm.mcpRefs),verificationMethod:chosenForm.verificationMethod,limitations:textLines(chosenForm.limitations),capabilityId:chosenForm.capabilityId,applicableScope:chosenForm.applicableScope,license:chosenForm.license,contributors:[...new Set(attributed.map(item=>item.authorId))],publicationClass:'formal-source-success',synthetic:fresh.synthetic===true,sourceResolution:{caseId:fresh.caseId,resultId:actualResult.id,resultVersion:actualResult.version,proofIds:[],verificationRefs:selected.filter(item=>item.ref.kind==='verification').map(item=>({id:item.ref.id,version:item.ref.version}))},sourceRefs:selected.map(item=>item.ref),permissionRefs:chosenForm.permissionIds,attributionRefs:attributed.map(item=>({subjectId:item.authorId,source:item.ref})),externalReferences:chosenForm.externalReferences,redactionConfirmed:true};
 }
 async function prepare(){
  const token=epoch.current;assertCurrent(token);setMessage('');setChecking(true);
  try{
   const saved=await snapshot();assertCurrent(token);const chosen={...initialValue,...saved.value,form:{...initialValue.form,...saved.value.form}};
   if(mode==='maintenance'){
    if(!disclosure||!management||!detail?.versionId)throw Error('当前版本与原展示范围尚未读到。');
    const current=await client.versions({capsuleId:detail.capsuleId,limit:1});assertCurrent(token);
    if(current.management?.revision!==chosen.expectedRevision){setCurrentManagement(current.management??null);throw Error('方法状态已变化，请核对当前状态后再维护。');}
    const payload:CapsulePublication={schemaVersion:2,id:crypto.randomUUID(),kind:chosen.maintenance,capsuleId:detail.capsuleId,versionId:detail.versionId,expectedRevision:chosen.expectedRevision,summary:chosen.summary,...(chosen.maintenance==='deprecate'&&chosen.replacement?{replacementVersionId:chosen.replacement}:{})};
    await propose('publication',payload,disclosure,context(saved,{title:detail.version?.title??'选定方法'}));return;
   }
   const payload=await publicationPayload(chosen,token);assertCurrent(token);
   let resolved=await client.resolvePublication(payload,{visibility:chosen.form.visibility});assertCurrent(token);setCheck(resolved.preview);
   if(!resolved.preview.readyForPublication)throw Error(methodInputError({code:resolved.preview.reason}));
   // Recover authors of restored body-free references from the exact source read.
   const reading=resolved.preview.sourceCoverage?.sources??[],attributionRefs=resolved.payload.sourceRefs.map(ref=>{
    const observed=reading.find(item=>capsuleRefKey(item.ref)===capsuleRefKey(ref));
    return observed?.authorId?{subjectId:observed.authorId,source:ref}:resolved.payload.attributionRefs.find(item=>capsuleRefKey(item.source)===capsuleRefKey(ref));
   }).filter((item):item is CapsuleVersion['attributionRefs'][number]=>item!==undefined);
   const attributedPayload={...resolved.payload,attributionRefs,contributors:[...new Set(attributionRefs.map(item=>item.subjectId))]};
   if(JSON.stringify(attributedPayload.attributionRefs)!==JSON.stringify(resolved.payload.attributionRefs)){
    const nextPreview=await client.preview(attributedPayload,{visibility:chosen.form.visibility});assertCurrent(token);setCheck(nextPreview);
    if(!nextPreview.readyForPublication)throw Error(methodInputError({code:nextPreview.reason}));
    resolved={...resolved,payload:attributedPayload,preview:nextPreview};
   }
   const currentSources=readableCaseSources(history.items.find(item=>item.caseId===chosen.form.caseId),chosen.form.sources);
   const sourceRows=await Promise.all((resolved.preview.sourceCoverage?.sources??[]).filter(item=>resolved.payload.sourceRefs.some(ref=>capsuleRefKey(ref)===capsuleRefKey(item.ref))).map(async item=>{
    assertCurrent(token);const value=item.ref.kind==='configuration'?{...item,view:await client.configuration({id:item.ref.id,version:item.ref.version})}:{...currentSources.find(source=>capsuleRefKey(source.ref)===capsuleRefKey(item.ref)),...item};
    assertCurrent(token);return value;
   }));assertCurrent(token);
   const permissions=await Promise.all(resolved.permissionRefs.map(id=>client.permission(id)));assertCurrent(token);
   await propose('publication',resolved.payload,{visibility:chosen.form.visibility,viewers:chosen.form.visibility==='Private'?chosen.viewers:[]},context(saved,{title:chosen.form.title,sourceTitle:source?.title??'所选实际工作',sources:sourceRows,coverage:resolved.preview.sourceCoverage,permissions,unavailablePermissionIds:resolved.unavailablePermissionIds}));
  }catch(error){
   try{assertCurrent(token);}catch{throw error;}
   const readable=methodInputError(error);setMessage(readable);throw Error(readable);
  }finally{try{assertCurrent(token);setChecking(false);}catch{/* The former editor cannot update the current view. */}}
 }
 function context(saved:{revision:string|null},display:CapsulePreviewDisplay):CapsulePreviewContext{
  return{draftKey,display,onJournal:async locator=>draftRef.current.attach(locator,saved.revision),onAcknowledged:async receipt=>draftRef.current.settle(async locator=>locator.operationId===receipt.operationId?client.receiptFor(locator):null)};
 }
 const textField=(key:FormTextKey,label:string,maxLength=1600,required=true)=><label htmlFor={fieldId+'-'+key}>{label}<Textarea id={fieldId+'-'+key} required={required} maxLength={maxLength} value={form[key]} onChange={event=>fieldChange(key,event.target.value)}/></label>;
 const inputField=(key:FormTextKey,label:string,maxLength=160,required=true)=><label htmlFor={fieldId+'-'+key}>{label}<Input id={fieldId+'-'+key} required={required} maxLength={maxLength} value={form[key]} onChange={event=>fieldChange(key,event.target.value)}/></label>;
 if(!draft.ready)return <p><output>{draft.status||'正在读取本机草稿…'}</output></p>;
 return <section ref={top} className="method-authoring method-author-workspace">
  {mode!=='maintenance'&&<nav className="method-author-stages" aria-label="整理方法"><button type="button" aria-current={input.step===0?'step':undefined} disabled={busy} onClick={()=>change({step:0})}>1. 阅读实际来源</button><button type="button" aria-current={input.step===1?'step':undefined} disabled={busy} onClick={()=>change({step:1})}>2. 写下做法与条件</button></nav>}
  {message&&<p role="alert" className="message error">{message}</p>}
  {currentManagement&&<aside className="method-source-change"><p>当前已有 {currentManagement.publishedVersionCount} 个发布版本。你的原输入保持完整。</p><Button type="button" variant="outline" disabled={busy} onClick={()=>change({expectedRevision:currentManagement.revision})}>以当前状态继续这份输入</Button></aside>}
  <form className="workspace-form" onSubmit={event=>{event.preventDefault();void run(prepare);}}>
   <fieldset disabled={busy||checking} className="method-authoring-fields">
   {mode==='maintenance'?<section className="method-form-section"><h2>维护这一版本</h2><p>{detail?.version?.title??'选定方法'} · 第 {detail?.version?.version??'所选'} 版</p>
    <label>需要怎样维护？<select value={input.maintenance} onChange={event=>change({maintenance:event.target.value==='security-issue'?'security-issue':event.target.value==='resolve-security'?'resolve-security':'deprecate'})}><option value="deprecate" disabled={detail?.deprecated}>停用这一版本</option><option value="security-issue" disabled={detail?.securityIssue}>说明安全事项</option><option value="resolve-security" disabled={!detail?.securityIssue}>记录安全事项处理</option></select></label>
    <label htmlFor={fieldId+'-maintenance'}>具体说明<Textarea id={fieldId+'-maintenance'} required maxLength={1600} value={input.summary} onChange={event=>change({summary:event.target.value})}/></label>
    {input.maintenance==='deprecate'&&<label>推荐的替代版本（可选）<select value={input.replacement} onChange={event=>change({replacement:event.target.value})}><option value="">不指定替代版本</option>{versionOptions.filter(value=>value.versionId!==detail?.versionId).map(value=><option value={value.versionId} key={value.versionId}>第 {value.version} 版 · {value.title??'来源当前不可用'}</option>)}</select></label>}<p className="source-reading-note">说明沿用这一版本的原展示范围。停用会保留此前的实际应用。</p>
   </section>:input.step===0?<>
    <section className="method-form-section"><h2>从已经发生的工作出发</h2><WorkSelection history={history} value={form.caseId} busy={busy} onChange={(caseId:string)=>fieldChange('caseId',caseId)}/>
     {source&&<><h3>{source.title}</h3>{source.synthetic&&<p className="permission-line">这件工作是合成演示，方法会保留此标记。</p>}<label>哪条实际结果支持这份方法？<select value={form.resultKey} onChange={event=>fieldChange('resultKey',event.target.value)}><option value="">选择实际结果</option>{mainResults.map(item=><option value={factKey(item)} key={factKey(item)}>{item.summary} · 第 {item.version} 版</option>)}{form.resultKey&&!result&&<option value={form.resultKey}>原选结果已变化或暂不可读取</option>}</select></label>{main&&<SourceReading item={main} subjectId={subjectId} names={people.names}/>}
      {!mainResults.length&&<p>这件工作还没有可支持新方法的成功结果。可以继续原工作，或选择另一件已发生的工作。</p>}
     </>}
    </section>
    <section className="method-form-section"><h2>保留做法的来处</h2><p>主结果及其必要上游会自动核对。再选择方法实际引用的背景、尝试、协助或检查，来源作者随这一条引用保留。</p>
     <div className="method-source-choices">{caseSources.filter(item=>!main||capsuleRefKey(item.ref)!==capsuleRefKey(main.ref)).map(item=><SourceReading key={capsuleRefKey(item.ref)} item={item} subjectId={subjectId} names={people.names}><label className="method-source-toggle"><input type="checkbox" checked={selectedKeys.has(capsuleRefKey(item.ref))} onChange={event=>chooseSource(item,event.target.checked)}/>引用这条来源并保留作者</label></SourceReading>)}</div>
     <CapsuleMessagePicker {...{runtime,subjectId,busy,run}} selected={extraSources} onChange={chooseExtra}/><ConfigurationPicker {...{runtime,subjectId,busy,run}} selected={extraSources} onChange={chooseExtra}/>
     {currentSelected.filter(item=>!caseSources.some(current=>capsuleRefKey(current.ref)===capsuleRefKey(item.ref))&&!['configuration','selected-message'].includes(item.ref.kind)).map(item=><SourceReading key={capsuleRefKey(item.ref)} item={{...item,unavailable:!item.reading}} subjectId={subjectId} names={people.names}><Button type="button" variant="ghost" onClick={()=>chooseSource(item,false)}>移除这一条引用</Button></SourceReading>)}
     <p className="source-reading-note">来源署名表示内容出自谁。共同署名仍由对方自己回应。</p>
    </section>
    <div className="method-author-next"><Button type="button" disabled={!result||busy} onClick={()=>{change({step:1});top.current?.scrollIntoView({block:'start'});}}>继续整理做法</Button></div>
   </>:<>
    <section className="method-form-section"><h2>让下一位读者能够照着做</h2><p className="method-source-context">{source?.title??'原工作正在重新核对'}{result?' · '+result.summary:''}<button type="button" className="text-link" onClick={()=>change({step:0})}>查看来源</button></p>
     {inputField('title','方法标题')}{textField('problemPattern','遇到了什么问题？',1200)}{textField('solutionStrategy','具体怎么做？',4000)}
    </section>
    <section className="method-form-section"><h2>必要条件与实际边界</h2><div className="method-form-pair">{inputField('environmentName','适用环境')}{inputField('environmentVersion','环境版本',80)}</div><p className="source-reading-note">只写实际知道的条件；未知处请明确写“未知”，不要用推测补齐。</p>
     {textField('applicableScope','适用于哪些情况？',1200)}{textField('verificationMethod','怎样核对效果，实际核对到哪里？',1200)}{textField('limitations','限制与不适用的情况（每行一项）',4000)}
     <label>方法分类<select required value={form.capabilityId} onChange={event=>fieldChange('capabilityId',event.target.value)}><option value="">选择分类</option>{[['software','软件与开发'],['writing','写作与整理'],['research','研究与分析'],['design','设计与体验'],['general','其他工作方法']].map(([value,label])=><option key={value} value={value}>{label}</option>)}{form.capabilityId&&!['software','writing','research','design','general'].includes(form.capabilityId)&&<option value={form.capabilityId}>{form.capabilityId}</option>}</select></label>
     <details className="method-optional-tools"><summary>使用的工具、Skill 或 MCP（可选）</summary>{textField('tools','工具（每行一项）',4000,false)}{textField('skills','Skill（每行一项）',4000,false)}{textField('mcpRefs','MCP（每行一项）',4000,false)}</details>
    </section>
    <section className="method-form-section"><h2>怎样分享和使用</h2>{inputField('license','内容许可',80)}<p className="source-reading-note">填写你有权采用的许可。已有来源许可会自动按作者、所选内容、截止时间和公开范围核对。</p>
     <label>谁可以阅读这份方法？<select value={form.visibility} onChange={event=>fieldChange('visibility',event.target.value==='Public'?'Public':'Private')}><option value="Private">本人和选定协作者</option><option value="Public">公开</option></select></label>
     {form.visibility==='Private'&&<PeopleSelection {...{people,subjectId}} value={input.viewers} onChange={(viewers:string[])=>change({viewers})} title="额外阅读者（可不选）"/>}
     {check&&<div className="method-coverage"><h3>来源许可核对</h3><p>{check.readyForPublication?'当前许可覆盖所选范围。':methodInputError({code:check.reason})}</p>{(check.sourceCoverage?.dependencies??[]).filter(item=>!item.covered).map(item=><p key={item.key}>{memberName(item.authorId,subjectId,people.names[item.authorId]??undefined)}的来源尚未覆盖本次范围。</p>)}{!check.readyForPublication&&<Button type="button" variant="outline" onClick={()=>navigate('/app/capsules?mode=permissions')}>查看来源许可</Button>}</div>}
     <details className="method-links"><summary>外部参考链接（可选）</summary><p>保留链接与说明，外部正文不会被导入。</p>{form.externalReferences.map((item,index)=><div className="method-link-row" key={index}><a href={item.url} target="_blank" rel="noreferrer">{item.description}</a><Button type="button" variant="ghost" onClick={()=>fieldChange('externalReferences',form.externalReferences.filter((_,other)=>index!==other))}>移除</Button></div>)}
      <label htmlFor={fieldId+'-external-url'}>链接<Input id={fieldId+'-external-url'} type="url" value={input.externalInput.url} onChange={event=>change({externalInput:{...input.externalInput,url:event.target.value}})}/></label><label htmlFor={fieldId+'-external-description'}>说明<Input id={fieldId+'-external-description'} value={input.externalInput.description} maxLength={1600} onChange={event=>change({externalInput:{...input.externalInput,description:event.target.value}})}/></label><label htmlFor={fieldId+'-external-license'}>已知许可（未知留空）<Input id={fieldId+'-external-license'} value={input.externalInput.license} maxLength={160} onChange={event=>change({externalInput:{...input.externalInput,license:event.target.value}})}/></label><Button type="button" variant="outline" disabled={!input.externalInput.url||!input.externalInput.description||form.externalReferences.length>=16} onClick={()=>{change({form:{...form,externalReferences:[...form.externalReferences,{...input.externalInput,license:input.externalInput.license||null,inclusion:'reference-only; no-imported-body'}]},externalInput:{url:'',description:'',license:''}});}}>加入链接</Button>
     </details>
     <p className="method-publication-intent">下一页会完整显示内容、实际来源和分享范围。确认保存时表示你已核对本人编写的文字，可按所选范围分享；他人来源仍由服务核对原作者许可。</p>
    </section>
   </>}
   <footer className="method-author-footer"><output>{draft.status||'填写后自动保存在此浏览器。'}</output>{(mode==='maintenance'||input.step===1)&&<Button type="submit">{checking?'正在核对来源…':mode==='maintenance'?'预览维护说明':'预览完整方法'}</Button>}</footer>
   </fieldset>
  </form>
 </section>;
}
