import { ReadingDetails, ReadingSummary } from './reading-details';
import React,{useCallback,useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {MemberAvatar,memberName,readableTime} from './conversation-ui';
import {capsuleRefKey} from './capsule-workspace-client.mjs';
import {CapsuleMessagePicker} from './capsule-source-picker';
import {ConfigurationPicker} from './configuration-picker';
import {useGovernanceDraft} from './governance-presentation';
import {CapsuleInputGate,capsuleInputDraftKey} from './capsule-authoring-state';
import {PeopleSelection,SourceReading,WorkSelection,methodInputError,readCapsulePermissionSources,readableCaseSources,sourceKind,sourceLocator,uniqueSources,useCapsulePeople,useCapsuleWorkHistory,useRegisteredCapsuleDraft,workPeople} from './capsule-authoring-shared';
import type {CapsuleAuthorClient,CapsuleAuthorRuntime,CapsuleLocator,CapsulePermissionGrant,CapsulePermissionInput,CapsulePermissionView,CapsulePropose,CapsuleRegisterDraft,CapsuleRun,CapsuleSourceItem} from './capsule-authoring-types';
import './capsule-authoring.css';

const blank=():CapsulePermissionInput=>({caseId:'',sources:[],grantees:[],license:'',scope:'',basis:'authored-content',licenseReference:'',attribution:'',allowPublic:false,expires:''});
const stateLabel=(value:CapsulePermissionView)=>value.revoked?'已撤销':value.expired?'已到期':value.sourceStatus==='current'?'当前有效':'来源当前不可用';
type PermissionProps={runtime:CapsuleAuthorRuntime;subjectId:string;client:CapsuleAuthorClient|null;busy:boolean;run:CapsuleRun;propose:CapsulePropose;registerDraft?:CapsuleRegisterDraft};
type PermissionEditorProps=Omit<PermissionProps,'client'>&{client:CapsuleAuthorClient};
type PermissionCatalog={client:CapsuleAuthorClient|null;owned:CapsulePermissionView[];granted:CapsulePermissionView[];loaded:boolean;error:string};
const emptyCatalog:PermissionCatalog={client:null,owned:[],granted:[],loaded:false,error:''};
export function CapsulePermissionWorkspace(props:PermissionProps){
 const {runtime,subjectId}=props,draftKey=capsuleInputDraftKey(runtime.api.endpoint,subjectId,'permissions');
 if(!props.client)return <output>连接当前身份后读取来源许可，原草稿仍保留。</output>;
 return <CapsuleInputGate {...{runtime,subjectId,draftKey}} normalize={()=>null}><CapsulePermissionEditor {...props} client={props.client} {...{draftKey}}/></CapsuleInputGate>;
}
function CapsulePermissionEditor({runtime,client,subjectId,busy,run,propose,draftKey,registerDraft}:PermissionEditorProps&{draftKey:string}){
 const [initial]=useState(blank),draft=useGovernanceDraft<CapsulePermissionInput,CapsuleLocator>(runtime,subjectId,true,draftKey,initial),draftRef=useRegisteredCapsuleDraft(draft,draftKey,client,registerDraft),input={...initial,...draft.value};
 const history=useCapsuleWorkHistory(client,input.caseId,busy),source=history.items.find(item=>item.caseId===input.caseId),caseSources=readableCaseSources(source,input.sources).filter(item=>item.authorId===subjectId);
 const [catalogView,setCatalog]=useState(emptyCatalog),[grantOpen,setShowGrant]=useState(false),[revoke,setRevoke]=useState<string|null>(()=>new URLSearchParams(location.search).get('revoke')),[revokeRead,setRevokeView]=useState<{client:CapsuleAuthorClient;permissionId:string;catalog:PermissionCatalog;value:CapsulePermissionView|null;error:string}|null>(null);
 const catalog=catalogView.client===client?catalogView:emptyCatalog,loaded=catalog.loaded,revokeView=revokeRead?.client===client&&revokeRead.permissionId===revoke&&revokeRead.catalog===catalog?revokeRead:null,readError=catalog.error||revokeView?.error||'',showGrant=grantOpen||draft.ready&&!!(input.sources.length||input.scope||input.license||input.grantees.length);
 const active=useRef(true),reading=useRef(false),ticket=useRef(0),latest=useRef({busy,client}),fieldId=useId();
 useLayoutEffect(()=>{latest.current={busy,client};},[busy,client]);
 const people=useCapsulePeople(runtime,subjectId,[...workPeople(source),...input.grantees,...catalog.owned.flatMap(item=>[item.authorId,...item.payload.grantees]),...catalog.granted.flatMap(item=>[item.authorId,...item.payload.grantees])]);
 const extras=input.sources.filter(item=>['configuration','selected-message'].includes(item.ref.kind));
 const refresh=useCallback(async()=>{
  if(reading.current||latest.current.client!==client)return;const token=++ticket.current;reading.current=true;
  try{const [owned,granted]=await Promise.all([client.allPermissions({view:'owned'}),client.allPermissions({view:'granted'})]);if(!active.current||token!==ticket.current||latest.current.client!==client)return;setCatalog({client,owned:owned.items,granted:granted.items,loaded:true,error:''});}
  catch(error){if(active.current&&token===ticket.current&&latest.current.client===client)setCatalog({client,owned:[],granted:[],loaded:false,error:methodInputError(error)});}
  finally{if(token===ticket.current)reading.current=false;}
 },[client]);
 useEffect(()=>{active.current=true;reading.current=false;const requests=ticket;requests.current++;const start=window.setTimeout(()=>void refresh(),0),reload=()=>{if(!document.hidden&&!latest.current.busy)void refresh();};const timer=window.setInterval(reload,15000);document.addEventListener('visibilitychange',reload);return()=>{active.current=false;requests.current++;window.clearTimeout(start);window.clearInterval(timer);document.removeEventListener('visibilitychange',reload);};},[refresh]);
 useEffect(()=>{let live=true;if(revoke)void client.permission(revoke).then(value=>{if(live)setRevokeView({client,permissionId:revoke,catalog,value,error:''});}).catch(()=>{if(live)setRevokeView({client,permissionId:revoke,catalog,value:null,error:'所选许可当前无法读取。撤销说明仍保留。'});});return()=>{live=false;};},[revoke,client,catalog]);
 function selectRevoke(id:string|null){const url=new URL(location.href);if(id)url.searchParams.set('revoke',id);else url.searchParams.delete('revoke');window.history.replaceState(window.history.state,'',url.pathname+url.search+url.hash);setRevoke(id);}
 function choose(item:CapsuleSourceItem,selected:boolean){const rest=input.sources.filter(other=>capsuleRefKey(other.ref)!==capsuleRefKey(item.ref));draft.change({sources:selected?[...rest,sourceLocator(item)]:rest});}
 function chooseExtras(items:CapsuleSourceItem[]){draft.change({sources:uniqueSources([...input.sources.filter(item=>!['configuration','selected-message'].includes(item.ref.kind)),...items.map(sourceLocator)])});}
 async function prepare(){
  let saved=await draft.snapshot();if(!saved.revision){draft.change(saved.value);saved=await draft.snapshot();}
  const chosen={...initial,...saved.value};if(!chosen.sources.length)throw Error('选择要允许使用的本人来源。');if(!chosen.grantees.length)throw Error('选择明确获许可的人。');
  const rows=await history.load(),facts=readableCaseSources((rows??history.items).find(item=>item.caseId===chosen.caseId),chosen.sources);
  const sources=await readCapsulePermissionSources(runtime,client,subjectId,chosen.sources,facts);
  if(sources.some(item=>item.authorId!==subjectId))throw Error('这里只能许可本人创作的选定来源，请重新核对作者。');
  if(chosen.expires&&new Date(chosen.expires).getTime()<=Date.now())throw Error('额外截止时间应晚于当前时间。原输入仍保留。');
  const payload:CapsulePermissionGrant={schemaVersion:2,id:crypto.randomUUID(),kind:'grant',sources:sources.map(item=>item.ref),grantees:chosen.grantees,license:chosen.license,scope:chosen.scope,basis:chosen.basis,...(chosen.basis==='documented-covering-license'?{licenseReference:chosen.licenseReference}:{}),attribution:chosen.attribution,allowPublic:chosen.allowPublic,...(chosen.expires?{expiresAt:new Date(chosen.expires).toISOString()}:{})};
  await propose('permission',payload,{visibility:'Private',viewers:chosen.grantees},{draftKey,display:{sources,title:'允许使用选定来源'},onJournal:locator=>draftRef.current.attach(locator,saved.revision),onAcknowledged:async receipt=>{const cleared=await draftRef.current.settle(async locator=>locator.operationId===receipt.operationId?client.receiptFor(locator):null);await refresh();if(cleared)setShowGrant(false);}});
 }
 const textField=(key:'scope'|'attribution',label:string,max=1600)=><label htmlFor={fieldId+'-'+key}>{label}<Textarea id={fieldId+'-'+key} required maxLength={max} value={input[key]} onChange={event=>draft.change({[key]:event.target.value})}/></label>;
 return <section className="method-permission-workspace">
  <section className="method-permission-directory"><header><div><h2>现有来源许可</h2><p>读者范围、原作者和准确来源随许可保留。方法保存前会自动核对当前有效许可。</p></div><Button type="button" disabled={busy||!draft.ready} onClick={()=>setShowGrant(true)}>允许他人使用我的来源</Button></header>
   {readError&&<p role="alert" className="message error">{readError}<Button variant="ghost" disabled={busy} onClick={()=>void refresh()}>重新读取</Button></p>}
   {!loaded&&!readError&&<p><output>正在读取现有许可…</output></p>}
   {(['granted','owned'] as const).map(view=><section key={view}><h3>{view==='granted'?'我收到的许可':'我给出的许可'}</h3>{loaded&&!catalog[view].length&&<p className="source-reading-note">{view==='granted'?'当前没有明确授予你的来源许可。':'你还没有授予来源许可。'}</p>}<div className="method-permission-list">{catalog[view].map(value=><article className="method-permission-card" key={value.permissionId}>
    <header><span className="method-source-person"><MemberAvatar subjectId={value.authorId}/>{memberName(value.authorId,subjectId,people.names[value.authorId]??undefined)}</span><span>{stateLabel(value)}</span></header>
    <h4>{value.payload?.license??'来源许可'}</h4><p className="reading-prose">{value.payload?.scope}</p><p>获许可人：{(value.payload?.grantees??[]).map((id:string)=>memberName(id,subjectId,people.names[id]??undefined)).join('、')}</p><p>署名要求：{value.payload?.attribution}</p><p className="source-reading-note">{value.payload?.allowPublic?'允许在此许可范围内公开':'限许可范围内使用，不允许公开'}{value.payload?.expiresAt?' · 截至 '+readableTime(value.payload.expiresAt):' · 仍受原授权有效期限制'}</p>
    <ReadingDetails className="source-reference-details"><ReadingSummary>准确来源与许可依据</ReadingSummary><p>{value.payload?.basis==='documented-covering-license'?'依据覆盖许可文件：'+value.payload?.licenseReference:'原作者许可本人创作的选定内容'}</p>{value.payload.sources.map(ref=><p key={capsuleRefKey(ref)}>{sourceKind(ref.kind)} · 第 {ref.version} 版 <code>{ref.id}</code></p>)}</ReadingDetails>
    {view==='owned'&&!value.revoked&&!value.expired&&<Button type="button" variant="outline" disabled={busy} onClick={()=>selectRevoke(value.permissionId)}>撤销这项许可</Button>}
   </article>)}</div></section>)}
  </section>
  {revoke&&<CapsuleInputGate {...{runtime,subjectId}} draftKey={capsuleInputDraftKey(runtime.api.endpoint,subjectId,'permission-revoke',revoke)} normalize={()=>null}><RevokeSourcePermission {...{runtime,subjectId,client,busy,run,propose,registerDraft}} permissionId={revoke} view={revokeView?.value??null} onClose={()=>selectRevoke(null)} onChanged={refresh}/></CapsuleInputGate>}
  {showGrant&&<section className="method-form-section method-permission-editor"><header><h2>允许他人使用我的来源</h2><p>只选择你创作的内容，并明确使用人、范围和署名要求。</p></header>
   {!draft.ready?<p><output>{draft.status||'正在读取本机草稿…'}</output></p>:<form className="workspace-form" onSubmit={event=>{event.preventDefault();void run(prepare);}}><fieldset disabled={busy}>
    <WorkSelection label="来源属于哪件工作？" history={history} value={input.caseId} onChange={(caseId:string)=>draft.change({caseId})} busy={busy}/>
    <div className="method-source-choices">{caseSources.map(item=><SourceReading item={item} key={capsuleRefKey(item.ref)} subjectId={subjectId} names={people.names}><label className="method-source-toggle"><input type="checkbox" checked={input.sources.some(other=>capsuleRefKey(other.ref)===capsuleRefKey(item.ref))} onChange={event=>choose(item,event.target.checked)}/>允许使用这一条内容</label></SourceReading>)}</div>
    <CapsuleMessagePicker {...{runtime,subjectId,busy,run}} onlyOwn selected={extras} onChange={chooseExtras}/><ConfigurationPicker {...{runtime,subjectId,busy,run}} onlyOwn selected={extras} onChange={chooseExtras}/>
    {input.sources.filter(item=>!caseSources.some(current=>capsuleRefKey(current.ref)===capsuleRefKey(item.ref))&&!['configuration','selected-message'].includes(item.ref.kind)).map(item=><SourceReading key={capsuleRefKey(item.ref)} item={{...item,unavailable:true}} subjectId={subjectId} names={people.names}><Button type="button" variant="ghost" onClick={()=>choose(item,false)}>移除这一条引用</Button></SourceReading>)}
    <PeopleSelection {...{people,subjectId}} title="明确允许谁使用？" value={input.grantees} onChange={(grantees:string[])=>draft.change({grantees})}/>
    <label htmlFor={fieldId+'-license'}>许可名称<Input id={fieldId+'-license'} required maxLength={80} value={input.license} onChange={event=>draft.change({license:event.target.value})}/></label>
    {textField('scope','允许使用的具体范围')}{textField('attribution','使用时应怎样署名？')}
    <label>许可依据<select value={input.basis} onChange={event=>{const basis=event.target.value;if(basis==='authored-content'||basis==='documented-covering-license')draft.change({basis});}}><option value="authored-content">本人创作的选定内容</option><option value="documented-covering-license">已有文件明确覆盖的许可</option></select></label>
    {input.basis==='documented-covering-license'&&<label htmlFor={fieldId+'-license-reference'}>覆盖许可的实际文件或链接<Input id={fieldId+'-license-reference'} required maxLength={1200} value={input.licenseReference} onChange={event=>draft.change({licenseReference:event.target.value})}/></label>}
    <label className="method-source-toggle"><input type="checkbox" checked={input.allowPublic} onChange={event=>draft.change({allowPublic:event.target.checked})}/>允许按这项许可公开选定内容</label>
    <label htmlFor={fieldId+'-expires'}>额外截止时间（可选）<Input id={fieldId+'-expires'} type="datetime-local" value={input.expires} onChange={event=>draft.change({expires:event.target.value})}/></label><p className="source-reading-note">实际许可仍受原授权有效期限制。此许可不替代其他作者的同意。</p>
    <footer className="method-author-footer"><span><output>{draft.status||'填写后自动保存在此浏览器。'}</output></span><Button type="submit">预览来源许可</Button></footer>
   </fieldset></form>}
  </section>}
 </section>;
}
function RevokeSourcePermission({runtime,subjectId,client,busy,run,propose,registerDraft,permissionId,view,onClose,onChanged}:PermissionEditorProps&{permissionId:string;view:CapsulePermissionView|null;onClose:()=>void;onChanged:()=>Promise<void>}){
 const draftKey=capsuleInputDraftKey(runtime.api.endpoint,subjectId,'permission-revoke',permissionId),draft=useGovernanceDraft<{reason:string},CapsuleLocator>(runtime,subjectId,true,draftKey,{reason:''}),draftRef=useRegisteredCapsuleDraft(draft,draftKey,client,registerDraft),fieldId=useId();
 async function prepare(){let saved=await draft.snapshot();if(!saved.revision){draft.change(saved.value);saved=await draft.snapshot();}const current=await client.permission(permissionId);if(current.authorId!==subjectId||current.revoked)throw Error('这项许可当前已撤销或不是本人授予。');await propose('permission',{schemaVersion:2,id:crypto.randomUUID(),kind:'revoke',permissionId,reason:saved.value.reason},{visibility:'Private',viewers:current.payload.grantees},{draftKey,display:{title:current.payload.scope,permission:current},onJournal:locator=>draftRef.current.attach(locator,saved.revision),onAcknowledged:async receipt=>{await draftRef.current.settle(async locator=>locator.operationId===receipt.operationId?client.receiptFor(locator):null);await onChanged();onClose();}});}
 return <section className="method-form-section method-permission-revoke"><h2>撤销这项来源许可</h2><p>{view?.payload.scope??'正在读取原许可…'}</p><p>依赖这项许可的内容会重新核对当前可读性。原作者与已经发生的工作仍保留。</p><form onSubmit={event=>{event.preventDefault();void run(prepare);}}><fieldset disabled={busy||!draft.ready||!view}><label htmlFor={fieldId}>撤销原因<Textarea id={fieldId} required maxLength={1600} value={draft.value.reason} onChange={event=>draft.change({reason:event.target.value})}/></label><span><output>{draft.status}</output></span><div className="button-row"><Button type="submit">预览撤销说明</Button><Button type="button" variant="ghost" onClick={onClose}>保留许可</Button></div></fieldset></form></section>;
}
