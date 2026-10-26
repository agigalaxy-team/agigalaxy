import { ReadingDetails, ReadingSummary } from "../../shared/reading/reading-details";
import React,{useCallback,useEffect,useEffectEvent,useId,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Plus, X} from 'lucide-react';
import {memberName,useMemberNames,readableTime} from "../../shared/people/conversation-ui";
import {useGovernanceDraft} from "../governance/governance-presentation";
import {useChoiceViewLease} from "../../shared/operations/choice-retained-operations";
import type {ChoiceViewLease} from "../../shared/operations/choice-retained-operations";
import type {ToolRuntime,ConfigurationEvent,ConfigurationRecord,ConfigurationView as ConfigurationRead,ConfigurationClient,ConfigurationInput,ConfigurationComponent,ConfigurationTextField,ConfigurationLegacy,ToolContact,ToolContactsPage,ToolLocator,ToolReceipt,ToolPending,ToolOriginal,ToolAuthorization,ToolJournalClient,ToolDraftFlush} from './tool-workspace-state';
import {toolErrorField,toolReceiptId,toolAuthorization,conditionPairs,componentPairs,createTypedConfigurationClient} from './tool-workspace-state';
import './tool-workspace.css';

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export function toolReturnPath(value:unknown){
 try{if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//'))return null;const url=new URL(value,location.origin);return url.origin===location.origin&&url.pathname.startsWith('/app/')?url.pathname+url.search+url.hash:null;}catch{return null;}
}
const toolErrors:Record<string,string>={
 pack_use_maintenance_blocked:'这个工具版本已下架或有待处理的安全事项，请查看当前说明。',
 pack_use_attempt_unavailable:'所选尝试版本目前不可读，原选择仍保留。',
 pack_use_configuration_unavailable:'这次尝试引用的配置版本目前不可读，原选择仍保留。',
 pack_use_configuration_mismatch:'尝试与配置引用不一致，请重新读取原工作。',
 pack_use_version_conflict:'这份使用记录已有更新，请先核对当前内容。',
 configuration_version_conflict:'这份配置已有更新，请先核对当前版本。',
 configuration_content_unavailable:'这个配置版本目前不可读。',
 configuration_unavailable:'这份配置目前不可读。',
};
export const toolError=(error:unknown)=>toolErrors[toolErrorField(error,'code')||toolErrorField(error,'message')]??(toolErrorField(error,'message').trim()||'暂时无法完成，原输入仍保留。');
const configurationStatus=(status:string)=>({current:'当前可读',active:'当前可读','historical-version':'历史版本可读',revoked:'已撤回','source-unavailable':'来源暂不可读','content-unavailable':'正文暂不可读'} as Record<string,string>)[status]??'当前状态待核对';
const localTime=(value:string)=>{const date=new Date(value);return Number.isFinite(date.getTime())?new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,19):'';};
const blank=():ConfigurationInput=>({title:'',summary:'',modelName:'',modelVersion:'',runtimeName:'',runtimeVersion:'',environmentName:'',environmentVersion:'',tools:[],skills:[],mcp:[],promptPolicyVersion:'',rulesVersion:'',operationScope:'',inputScopeSummary:'',contentFingerprint:'',limitations:'',observedAt:'',synthetic:false,visibility:'Private',viewers:[],expectedVersion:0,sections:[]});
function configurationInput(value:ConfigurationRead|null){
 const input=blank(),record=value?.record,conditions=record?.conditions;if(!record||!conditions)return input;
 return{...input,title:record.title,summary:record.summary,modelName:conditions.model.name??'',modelVersion:conditions.model.version??'',runtimeName:conditions.runtime.name??'',runtimeVersion:conditions.runtime.version??'',environmentName:conditions.environment.name??'',environmentVersion:conditions.environment.version??'',tools:conditions.tools??[],skills:conditions.skills??[],mcp:conditions.mcp??[],promptPolicyVersion:conditions.promptPolicyVersion??'',rulesVersion:conditions.rulesVersion??'',operationScope:(conditions.operationScope??[]).join('\n'),inputScopeSummary:conditions.inputScopeSummary??'',contentFingerprint:conditions.contentFingerprint??'',limitations:conditions.limitations??'',observedAt:localTime(record.observedAt),synthetic:record.synthetic===true,visibility:value.disclosure?.visibility??'Private',viewers:value.disclosure?.viewers??[],expectedVersion:value.management?.version??value.version,sections:['environment',...((['tools','skills','mcp'] as const).some(key=>conditions[key]?.length)?['tools']:[])]};
}
function configurationPayload(input:ConfigurationInput,{subjectId,id,operationId,expectedVersion}:{subjectId:string;id:string;operationId:string;expectedVersion:number}):ConfigurationRecord{
 const component=(items:ConfigurationComponent[])=>items.map(item=>({name:item.name.trim(),version:item.version?.trim()||null,...(item.reference?.trim()?{reference:item.reference.trim()}:{})}));
 return{schemaVersion:2,kind:'record',id,operationId,expectedVersion,actorId:subjectId,title:input.title.trim(),summary:input.summary.trim(),conditions:{model:{name:input.modelName.trim()||null,version:input.modelVersion.trim()||null},runtime:{name:input.runtimeName.trim()||null,version:input.runtimeVersion.trim()||null},environment:{name:input.environmentName.trim()||null,version:input.environmentVersion.trim()||null},tools:component(input.tools),skills:component(input.skills),mcp:component(input.mcp),promptPolicyVersion:input.promptPolicyVersion.trim()||null,rulesVersion:input.rulesVersion.trim()||null,operationScope:input.operationScope.split('\n').map((value:string)=>value.trim()).filter(Boolean),inputScopeSummary:input.inputScopeSummary.trim()||null,limitations:input.limitations.trim(),...(input.contentFingerprint.trim()?{contentFingerprint:input.contentFingerprint.trim()}: {})},observedAt:new Date(input.observedAt).toISOString(),synthetic:input.synthetic,selectedFieldsOnly:true};
}
type ConfigurationRoute={id:string|null;version?:number;edit:''|'create'|'revision';returnTo:string|null};
type ConfigurationProps={runtime:ToolRuntime|null;subjectId?:string;connected:boolean;navigate:(path:string)=>void};
const configRoute=():ConfigurationRoute=>{const q=new URLSearchParams(location.search),id=q.get('configurationId'),v=Number(q.get('version'));return{id:uuid(id)?id:null,version:Number.isSafeInteger(v)&&v>0?v:undefined,edit:q.get('edit')==='create'?'create':q.get('edit')==='revision'&&uuid(id)?'revision':'',returnTo:toolReturnPath(q.get('returnTo'))};};
export function ConfigurationWorkspace(props:ConfigurationProps){
 const scope=useChoiceViewLease(props.runtime,props.subjectId),[route,setRoute]=useState(configRoute),[seenSearch,setSeenSearch]=useState(location.search),search=location.search;
 if(seenSearch!==search){setSeenSearch(search);setRoute(configRoute());}
 useEffect(()=>{const changed=()=>{setSeenSearch(location.search);setRoute(configRoute());};addEventListener('popstate',changed);return()=>removeEventListener('popstate',changed);},[]);
 const onRoute=(patch:Partial<ConfigurationRoute>)=>{const next={...route,...patch},url=new URL(location.href);for(const key of ['configurationId','version','edit'])url.searchParams.delete(key);if(next.id)url.searchParams.set('configurationId',next.id);if(next.version)url.searchParams.set('version',String(next.version));if(next.edit)url.searchParams.set('edit',next.edit);history.replaceState(history.state,'',url.pathname+url.search+url.hash);setSeenSearch(location.search);setRoute(next);};
 if(!props.runtime)return <output>正在读取连接配置…</output>;
 return <ConfigurationView key={JSON.stringify([scope.key,props.runtime.api.endpoint,route.id,route.version])} {...props} runtime={props.runtime} lease={scope.lease} route={route} onRoute={onRoute}/>;
}
function ConfigurationView({runtime,subjectId,connected,navigate,lease,route,onRoute}:Omit<ConfigurationProps,'runtime'>&{runtime:ToolRuntime;lease:ChoiceViewLease|null;route:ConfigurationRoute;onRoute:(patch:Partial<ConfigurationRoute>)=>void}){
 const client:ConfigurationClient=useMemo(()=>createTypedConfigurationClient(runtime,subjectId),[runtime,subjectId]);
 const [items,setItems]=useState<ConfigurationRead[]>([]),[next,setNext]=useState<string|null>(null),[detail,setDetail]=useState<ConfigurationRead|null>(null),[versions,setVersions]=useState<ConfigurationRead[]>([]),[versionNext,setVersionNext]=useState<number|null>(null),[versionsOpen,setVersionsOpen]=useState(false);
 const [loaded,setLoaded]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[revoke,setRevoke]=useState(false),[reason,setReason]=useState(''),[recoveryRequest,setRecoveryRequest]=useState(0),[legacy,setLegacy]=useState<ConfigurationLegacy|null>(null);
 const epoch=useRef(0),working=useRef(false),readVersion=useRef(0),pages=useRef<(string|undefined)[]>([undefined]),dialog=useRef<HTMLDialogElement>(null),editorFlush=useRef<ToolDraftFlush>(null);
 const valid=(token:number)=>{if(epoch.current!==token)return false;try{lease?.assertCurrent();return !connected||!!lease;}catch{return false;}};
 const changeRoute=(patch:Partial<ConfigurationRoute>)=>{onRoute(patch);setError('');setNotice('');};
 const registerFlush=useCallback((flush:ToolDraftFlush)=>{editorFlush.current=flush;},[]);
 async function readList(after?:string){
  const token=epoch.current,request=++readVersion.current;
  try{const cursors=after?[after]:pages.current,rows:ConfigurationRead[]=[];let cursor:string|null=null;for(const page of cursors){const result=await client.query({subjectId,limit:20,...(page?{after:page}:{})});if(!valid(token)||request!==readVersion.current)return;rows.push(...result.items);cursor=result.nextAfter;}setItems(old=>after?[...old,...rows]:rows);setNext(cursor);setLoaded(true);if(after)pages.current.push(after);}
  catch(e){if(valid(token)&&request===readVersion.current){setItems([]);setNext(null);setLoaded(true);throw e;}}
 }
 async function readDetail(id:string,version?:number){
  const token=epoch.current,request=++readVersion.current;
  try{const result=await client.get({id,...(version?{version}:{})});if(!valid(token)||request!==readVersion.current)return; if(result.id!==id)throw Error('所选配置与读取结果不一致。');setDetail(result);}
  catch(e){if(valid(token)&&request===readVersion.current){setDetail(null);setVersions([]);throw e;}}
 }
 async function readVersions(afterVersion=0){
  if(!route.id)return;const token=epoch.current,id=route.id;
  try{const result=await client.versions({id,afterVersion,limit:20});if(!valid(token)||id!==route.id)return;if(result.id!==id||result.items.some(value=>value.id!==id))throw Error('版本结果与所选配置不一致。');setVersions(old=>afterVersion?[...old,...result.items]:result.items);setVersionNext(result.nextAfterVersion);}catch(e){if(valid(token)){setVersions([]);setVersionNext(null);}throw e;}
 }
 async function run(fn:()=>Promise<void>){if(working.current)return;const token=epoch.current;working.current=true;setBusy(true);setError('');try{await fn();}catch(e){if(valid(token))setError(toolError(e));}finally{working.current=false;if(valid(token))setBusy(false);}}
 async function refresh(){if(!connected||!lease||working.current)return;const token=epoch.current;try{if(route.id)await readDetail(route.id,route.version);else await readList();if(valid(token)&&versionsOpen)await readVersions();}catch(e){if(valid(token))setError(toolError(e));}}
 const refreshCurrent=useEffectEvent(refresh);
 const acceptInitial=useEffectEvent((value:ConfigurationRead|{items:ConfigurationRead[];nextAfter:string|null},token:number)=>{if(!valid(token))return;if('items'in value){setItems(value.items);setNext(value.nextAfter);setLoaded(true);}else{if(value.id!==route.id)throw Error('所选配置与读取结果不一致。');setDetail(value);}});
 const acceptLegacy=useEffectEvent((value:ConfigurationLegacy|null,token:number)=>{if(valid(token))setLegacy(value);});
 const readFailure=useEffectEvent((error:unknown,token:number)=>{if(valid(token)){setError(toolError(error));setLoaded(true);}});
 useEffect(()=>{const token=++epoch.current;if(connected&&lease){const reading=route.id?client.get({id:route.id,...(route.version?{version:route.version}:{})}):client.query({subjectId,limit:20});void reading.then(value=>acceptInitial(value,token)).catch(error=>readFailure(error,token));}return()=>{epoch.current=token+1;};},[client,connected,lease,route.id,route.version,subjectId]);
 useEffect(()=>{const tick=()=>{if(!document.hidden)void refreshCurrent();};const timer=setInterval(tick,20000);document.addEventListener('visibilitychange',tick);return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',tick);};},[]);
 useEffect(()=>{if(!connected||!lease)return;const token=epoch.current;void client.loadDraft().then(value=>acceptLegacy(value,token)).catch(()=>{});},[client,connected,lease]);
 useEffect(()=>{if(revoke)dialog.current?.showModal();else dialog.current?.close();},[revoke]);
 async function completed(receipt:ToolReceipt){if(!receipt?.id)return;setNotice('上次配置提交已保存。');if(route.id===receipt.id)await readDetail(toolReceiptId(receipt));else if(!route.edit&&!route.id)await readList();}
 async function revokeConfiguration(){
  if(!detail?.id||!lease||!subjectId)throw Error('请先读取这份配置。');const original=detail,current=await client.get({id:original.id});lease.assertCurrent();
  if(current.management?.state!=='active')throw Error('这份配置已撤回或当前不能修改。');
  if(current.management.version!==original.management?.version){setDetail(current);throw Error('配置已有更新，请查看当前版本后再决定是否撤回。');}
  if((await client.pending()).some(op=>op.state!=='stopped-local')){setRecoveryRequest(value=>value+1);throw Error('先确认上一份提交的保存结果。');}
  const prepared=await client.prepare({schemaVersion:2,id:current.id,operationId:crypto.randomUUID(),expectedVersion:current.management.version,actorId:subjectId,kind:'revoke',reason:reason.trim()},{visibility:'Private',viewers:[]});
  const receipt=await client.execute(prepared,{confirmed:true});lease.assertCurrent();setRevoke(false);setReason('');setNotice('配置已撤回。');await readDetail(toolReceiptId(receipt));
 }
 return <section className="tool-workspace configuration-workspace">
  <header className="tool-page-heading"><div><h1>{route.edit==='create'?'记录配置':route.edit?'更新配置':route.id?(detail?.record?.title??'配置记录'):'我的配置'}</h1>{!route.id&&!route.edit&&<p>为以后复现工作保留实际知道的条件，需要时再记录。</p>}</div>{connected&&!route.id&&!route.edit&&<Button onClick={()=>changeRoute({edit:'create'})}><Plus size={16}/>记录配置</Button>}</header>
  {!connected||!lease||!subjectId?<section className="empty-state"><h2>连接后查看自己的配置</h2><p>工具可以在自己的环境直接使用。这里保存本人选定的条件与版本。</p><Button onClick={()=>navigate('/app/settings/identity')}>连接身份</Button></section>:<>
   {(route.id||route.edit)&&<button className="back-link" onClick={()=>void run(async()=>{if(route.edit)await editorFlush.current?.();changeRoute({id:null,version:undefined,edit:''});})}>我的配置</button>}
   {route.returnTo&&<a className="tool-return" href={route.returnTo} onClick={e=>{e.preventDefault();void run(async()=>{if(route.edit)await editorFlush.current?.();if(route.returnTo)navigate(route.returnTo);});}}>返回原事</a>}
   {error&&<p className="message error" role="alert">{error}</p>}{notice&&<output className="message">{notice}</output>}
   {!route.edit&&<ToolOperationStatus client={client} connected={connected} scopeKey={lease.bindingId+':'+lease.generation} paused={busy||revoke} request={recoveryRequest} onComplete={completed} renderContent={payload=><ConfigurationSubmittedContent payload={payload}/>}/>}
   {!route.id&&!route.edit&&<>
    {legacy?.form&&<aside className="resume-note"><div><strong>{legacy.form.title||'以前保留的配置草稿'}</strong><p>可继续原输入，提交前会重新核对版本。</p></div><Button variant="outline" onClick={()=>changeRoute({edit:legacy.mode==='revision'?'revision':'create',id:uuid(legacy.detail?.id)?legacy.detail.id:null})}>继续原稿</Button></aside>}
    {!loaded&&!error&&<output>正在读取配置…</output>}
    {loaded&&!items.length&&!error&&<p className="empty-state">还没有配置记录。只填实际知道的条件，其余可以留空。</p>}
    <div className="tool-reading-list">{items.map(item=><article key={item.id}><h2><button className="text-link" onClick={()=>changeRoute({id:item.id,version:undefined})}>{item.record?.title??'目前不可读的配置'}</button></h2>{item.record?.summary&&<p>{item.record.summary}</p>}<p className="record-meta">版本 {item.version} · {configurationStatus(item.sourceStatus)}</p></article>)}</div>
    {next&&<Button variant="outline" disabled={busy} onClick={()=>void run(()=>readList(next))}>更多配置</Button>}
   </>}
   {!detail&&!error&&route.id&&<output>正在读取这个版本…</output>}
   {route.id&&!route.edit&&detail&&<>
    <article className="tool-reading"><p className="record-meta">版本 {detail.version} · {configurationStatus(detail.sourceStatus)}</p>{detail.record?<ConfigurationContent value={detail.record}/>:<p>这个版本的正文已撤回、未提供或当前没有读取权限。</p>}
     <ReadingDetails className="tool-reference"><ReadingSummary>准确版本引用</ReadingSummary><p><code>{detail.id}</code> · 版本 {detail.version}</p></ReadingDetails>
     <ReadingDetails className="tool-versions" open={versionsOpen} onOpenChange={isOpen=>{const open=isOpen;setVersionsOpen(open);if(open)void run(()=>readVersions());}}><ReadingSummary>其他版本</ReadingSummary>{versions.length>0?<ul>{versions.map(value=><li key={value.version}><button className="text-link" onClick={()=>changeRoute({version:value.version})}>版本 {value.version} · {configurationStatus(value.sourceStatus)}</button></li>)}</ul>:<p>正在读取可见版本…</p>}{versionNext&&<Button variant="ghost" disabled={busy} onClick={()=>void run(()=>readVersions(versionNext))}>更早的版本</Button>}</ReadingDetails>
     {detail.management?.state==='active'&&<div className="tool-actions">{detail.record&&<Button onClick={()=>changeRoute({edit:'revision'})}>以这个版本记录更新</Button>}<Button variant="ghost" onClick={()=>{setRevoke(true);setReason('');}}>撤回</Button></div>}
    </article>
   </>}
   {route.edit&&(!route.id||detail)&&<ConfigurationEditor key={route.edit+':'+(route.id??'new')} runtime={runtime} subjectId={subjectId} lease={lease} client={client} id={route.id} initialView={detail?.id===route.id?detail:null} mode={route.edit} legacy={legacy} registerFlush={registerFlush} onSaved={async(receipt:ToolReceipt)=>{setLegacy(null);changeRoute({id:toolReceiptId(receipt),version:receipt.version,edit:''});setNotice('配置已保存。');}} onClose={()=>changeRoute({edit:''})}/>}
   <dialog ref={dialog} className="workspace-dialog tool-dialog" onCancel={e=>{if(busy)e.preventDefault();else setRevoke(false);}}>
    {revoke&&<form onSubmit={e=>{e.preventDefault();void run(revokeConfiguration);}}><header className="dialog-heading"><h2>撤回这份配置</h2><button type="button" className="icon-button" disabled={busy} aria-label="关闭撤回" onClick={()=>setRevoke(false)}><X size={19}/></button></header><p>{detail?.record?.title??'所选配置'} · 当前版本 {detail?.management?.version}</p><p>撤回后停止展示配置正文。已发生的工作仍保留准确版本引用。</p><label>撤回原因<textarea required maxLength={1600} value={reason} onChange={e=>setReason(e.target.value)}/></label>{error&&<p className="message error" role="alert">{error}</p>}<div className="tool-actions"><Button type="submit" disabled={busy}>确认撤回</Button><Button type="button" variant="outline" disabled={busy} onClick={()=>setRevoke(false)}>保留配置</Button></div></form>}
   </dialog>
  </>}
 </section>;
}
function ConfigurationEditor({runtime,subjectId,lease,client,id,mode,initialView,legacy,registerFlush,onSaved,onClose}:{runtime:ToolRuntime;subjectId:string;lease:ChoiceViewLease;client:ConfigurationClient;id:string|null;mode:'create'|'revision';initialView:ConfigurationRead|null;legacy:ConfigurationLegacy|null;registerFlush:(flush:ToolDraftFlush)=>void;onSaved:(receipt:ToolReceipt)=>Promise<void>;onClose:()=>void}){
 const fieldId=useId();
 const [initial]=useState(()=>configurationInput(initialView)),draft=useGovernanceDraft<ConfigurationInput,ToolLocator>(runtime,subjectId,true,'configuration-input:v2:'+JSON.stringify([runtime.api.endpoint,subjectId,id??'new']),initial);
 const [edited,setEdited]=useState(false),[legacyDismissed,setLegacyDismissed]=useState(false);
 const seedInput=(value:ConfigurationInput)=>!edited&&!draft.attempt&&!value.title&&!value.summary&&!value.observedAt?{...value,...initial}:value;
 const input=seedInput({...initial,...draft.value});
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[contacts,setContacts]=useState<ToolContact[]>([]),[contactNext,setContactNext]=useState<string|null>(null),[contactsLoaded,setContactsLoaded]=useState(false),[sharing,setSharing]=useState(false),[currentSource,setCurrentSource]=useState<ConfigurationRead|null>(null),[recoveryRequest,setRecoveryRequest]=useState(0);
 const working=useRef(false),active=useRef(true),draftApi=useRef(draft);
 useLayoutEffect(()=>{draftApi.current=draft;},[draft]);
 const people=[...new Set(contacts.filter(value=>value.state==='accepted').map(value=>value.initiatorId===subjectId?value.recipientId:value.initiatorId))].filter((id):id is string=>typeof id==='string'),names=useMemberNames(runtime,subjectId,true,[...people,...input.viewers]);
 const current=()=>{if(!active.current)return false;try{lease.assertCurrent();return true;}catch{return false;}};
 useEffect(()=>{active.current=true;registerFlush(()=>draftApi.current.snapshot());return()=>{active.current=false;registerFlush(null);};},[registerFlush]);
 const legacyAvailable=!!legacy?.form&&(!id||legacy.detail?.id===id)&&!input.title&&!input.summary&&!input.observedAt&&!legacyDismissed;
 function change(patch:Partial<ConfigurationInput>){draft.change({...input,...patch});setEdited(true);setError('');setCurrentSource(null);}
 async function run(fn:()=>Promise<void>){if(working.current)return;working.current=true;setBusy(true);setError('');try{await fn();}catch(e){if(current())setError(toolError(e));}finally{working.current=false;if(current())setBusy(false);}}
 async function receiptFor(locator:ToolLocator){if(locator?.family!=='configuration')return null;const receipt=await client.receiptFor({operationId:locator.operationId,payloadHash:locator.payloadHash});lease.assertCurrent();return receipt;}
 async function finish(receipt:ToolReceipt,show=true){const retired=await draftApi.current.settle(async(locator)=>locator.operationId===receipt.operationId?receipt:receiptFor(locator));if(!current())return;if(retired&&show)await onSaved(receipt);else setNotice('上次配置已保存，当前输入仍保留。');}
 const settleRestored=useEffectEvent(async(receipt:ToolReceipt|null)=>{if(current()&&receipt?.state==='acknowledged')await finish(receipt);});
 useEffect(()=>{if(!draft.ready||!draft.attempt)return;const locator=draft.attempt;if(locator.family!=='configuration')return;let live=true;void client.receiptFor(locator).then(receipt=>{lease.assertCurrent();if(live)return settleRestored(receipt);}).catch(()=>{});return()=>{live=false;};},[client,lease,draft.ready,draft.attempt]);
 async function contactsPage(after?:string){const result:ToolContactsPage=await runtime.api.call('/v2/contacts/query',{direction:'both',limit:20,...(after?{after}:{})});if(!current())return;setContacts(old=>after?[...old,...result.items]:result.items);setContactNext(result.nextAfter);setContactsLoaded(true);}
 function continueLegacy(){if(!legacy?.form)return;const old=legacy.form,parse=(value:ConfigurationComponent[]|string|undefined):ConfigurationComponent[]=>Array.isArray(value)?value:typeof value==='string'?value.split('\n').filter((line:string)=>line.trim()).map((line:string)=>{const [name,version,reference]=line.split('|').map(value=>value.trim());return{name,version:version||null,...(reference?{reference}:{})};}):[];
  const value:ConfigurationInput={...blank(),...old,tools:parse(old.tools),skills:parse(old.skills),mcp:parse(old.mcp),visibility:legacy.visibility??'Private',viewers:legacy.viewers??[],expectedVersion:legacy.detail?.management?.version??0,sections:['environment','tools']};draft.change(value);setLegacyDismissed(true);setNotice('已继续原输入。旧本机稿仍保留，当前来源会在保存时重新核对。');}
 async function save(){
  let snapshot=await draft.snapshot();if(!current())return;const chosen=seedInput({...initial,...snapshot.value});if(!snapshot.revision){draft.change(chosen);snapshot=await draft.snapshot();if(!current())return;}
  const retained=await client.pending();if(!current())return;
  if(draft.attempt){const receipt=await receiptFor(draft.attempt);if(receipt?.state==='acknowledged'){await finish(receipt);return;}setRecoveryRequest(value=>value+1);throw Error('这份原稿已有提交，先确认原操作的保存结果。');}
  if(retained.some(value=>value.state!=='stopped-local')){setRecoveryRequest(value=>value+1);throw Error('上一份配置仍在确认，先继续原提交。');}
  if(id){const source=await client.get({id});if(!current())return;if(source.management?.state!=='active')throw Error('这份配置已撤回或当前不能更新，输入仍保留。');if(source.management.version!==chosen.expectedVersion){setCurrentSource(source);throw Error('配置已有较新版本。请先核对当前版本，再决定是否用这些输入更新。');}}
  const payload=configurationPayload(chosen,{subjectId,id:id??crypto.randomUUID(),operationId:crypto.randomUUID(),expectedVersion:id?chosen.expectedVersion:0});
  const prepared=await client.prepare(payload,{visibility:chosen.visibility,viewers:chosen.visibility==='Public'?[]:chosen.viewers});if(!current())return;
  const receipt=await client.execute(prepared,{confirmed:true,onJournal:async()=>{if(!current())throw Error('身份或页面已变化。');await draftApi.current.attach({family:'configuration',operationId:prepared.operationId,payloadHash:prepared.payloadHash,id:payload.id},snapshot.revision);}});if(current())await finish(receipt);
 }
 const field=(label:string,name:ConfigurationTextField,multiline=false,required=false,max=160)=> <label key={name} htmlFor={fieldId+'-'+name}>{label}{multiline?<textarea id={fieldId+'-'+name} required={required} maxLength={max} value={input[name]??''} onChange={e=>change({[name]:e.target.value})}/>:<input id={fieldId+'-'+name} required={required} maxLength={max} value={input[name]??''} onChange={e=>change({[name]:e.target.value})}/>}</label>;
 const sectionShown=(name:string)=>input.sections.includes(name);
 const reveal=(name:string)=>change({sections:[...new Set([...input.sections,name])]});
 return <section className="tool-editor">
  <ToolOperationStatus client={client} connected scopeKey={lease.bindingId+':'+lease.generation} paused={busy} request={recoveryRequest} onComplete={receipt=>finish(receipt)} renderContent={payload=><ConfigurationSubmittedContent payload={payload}/>}/>
  {!draft.ready?<output>{draft.status||'正在读取本机原稿…'}</output>:<>
   {legacyAvailable&&<aside className="resume-note"><span>这里还有一份以前保存的原稿。</span><Button variant="outline" disabled={busy} onClick={continueLegacy}>继续以前的原稿</Button></aside>}
   {notice&&<output className="message">{notice}</output>}{error&&<p className="message error" role="alert">{error}</p>}
   {currentSource?.management&&<aside className="tool-source-change"><h2>当前版本 {currentSource.management.version}</h2>{currentSource.record&&<><h3>{currentSource.record.title}</h3><p>{currentSource.record.summary}</p></>}<p>以下输入保持原样。继续会以当前版本为基础新增一版。</p><Button variant="outline" disabled={busy} onClick={()=>{if(currentSource.management)change({expectedVersion:currentSource.management.version});setCurrentSource(null);}}>使用这些输入更新当前版本</Button></aside>}
   <form onSubmit={e=>{e.preventDefault();void run(save);}}>
    <fieldset disabled={busy||!draft.ready}>
     {field('配置名称','title',false,true)}
     {field('这份配置用来做什么？','summary',true,true,1600)}
     <div className="tool-time"><label>实际观察时间<input required type="datetime-local" step="1" value={input.observedAt} onChange={e=>change({observedAt:e.target.value})}/></label><button className="text-link" type="button" onClick={()=>change({observedAt:localTime(new Date().toISOString())})}>就是现在</button></div>
     <section className="tool-form-section"><h2>实际知道的条件</h2><p className="tool-help">只填已知内容；没有记录的项目保留为未知。</p>
      {!sectionShown('environment')?<button className="tool-add-section" type="button" onClick={()=>reveal('environment')}>＋ 模型、运行方式与系统环境</button>:<div className="tool-component-fields">{conditionPairs.map(([key,label])=><div className="tool-form-pair" key={key}>{field(label+'名称',`${key}Name`)}{field(label+'版本',`${key}Version`)}</div>)}</div>}
      {!sectionShown('tools')&&!(['tools','skills','mcp'] as const).some(key=>input[key]?.length)?<button className="tool-add-section" type="button" onClick={()=>reveal('tools')}>＋ 工具、Skill 或 MCP</button>:<div className="tool-components">{componentPairs.map(([key,label])=><section key={key}><h3>{label}</h3>{input[key].map((item,index)=><div className="tool-component-row" key={index}><label>{label}名称<input required value={item.name??''} maxLength={160} onChange={e=>change({[key]:input[key].map((row,i)=>i===index?{...row,name:e.target.value}:row)})}/></label><label>版本<input value={item.version??''} maxLength={80} onChange={e=>change({[key]:input[key].map((row,i)=>i===index?{...row,version:e.target.value}:row)})}/></label><label className="tool-component-reference">公开来源（可选）<input value={item.reference??''} maxLength={500} onChange={e=>change({[key]:input[key].map((row,i)=>i===index?{...row,reference:e.target.value}:row)})}/></label><button type="button" className="icon-button" aria-label={'移除'+label+'第'+(index+1)+'项'} onClick={()=>change({[key]:input[key].filter((_,i)=>i!==index)})}><X size={17}/></button></div>)}{input[key].length<32&&<button className="text-link" type="button" onClick={()=>change({[key]:[...input[key],{name:'',version:null}]})}>添加{label}</button>}</section>)}</div>}
      {field('已知限制或仍不确定的地方','limitations',true,true,1600)}
      <ReadingDetails mode="inline" className="tool-optional" open={!!input.operationScope||!!input.inputScopeSummary||undefined}><ReadingSummary>操作与材料范围</ReadingSummary>{field('实际可执行的操作（每行一项）','operationScope',true,false,5000)}{field('这次可用的材料范围','inputScopeSummary',true,false,1600)}</ReadingDetails>
      <ReadingDetails mode="inline" className="tool-optional"><ReadingSummary>策略版本与内容校验</ReadingSummary>{field('提示词策略版本','promptPolicyVersion')}{field('规则版本','rulesVersion')}{field('SHA-256 内容指纹','contentFingerprint',false,false,64)}</ReadingDetails>
     </section>
     <section className="tool-form-section"><h2>阅读范围</h2><label className="tool-visibility">谁可以查看？<select value={input.visibility} onChange={e=>change({visibility:e.target.value==='Public'?'Public':'Private'})}><option value="Private">仅我和选定协作者</option><option value="Public">公开这些选定内容</option></select></label>
      {input.visibility==='Private'&&<ReadingDetails mode="inline" className="tool-optional" open={sharing} onOpenChange={isOpen=>{setSharing(isOpen);if(isOpen&&!contactsLoaded)void run(()=>contactsPage());}}><ReadingSummary>{input.viewers.length?'已选 '+input.viewers.length+' 位协作者':'分享给协作者（可选）'}</ReadingSummary>{!contactsLoaded?<p>正在读取联系人…</p>:!people.length?<p>还没有已接受的联系人，可以仅自己保存。</p>:null}{[...new Set([...people,...input.viewers])].map(id=><label className="checkbox-label" key={id}><input type="checkbox" checked={input.viewers.includes(id)} onChange={e=>change({viewers:e.target.checked?[...input.viewers,id]:input.viewers.filter((value:string)=>value!==id)})}/>{memberName(id,subjectId,names[id]??undefined)}</label>)}{contactNext&&<Button type="button" variant="ghost" onClick={()=>void run(()=>contactsPage(contactNext))}>更多联系人</Button>}</ReadingDetails>}
      <p className="tool-help">保存这里选定的条件。密钥、提示词全文与未选材料留在自己的环境中。</p>
     </section>
     <label className="checkbox-label"><input type="checkbox" checked={input.synthetic} onChange={e=>change({synthetic:e.target.checked})}/>这是合成演示数据</label>
     <footer className="tool-form-footer"><Button type="submit" disabled={!!draft.attempt}>{mode==='revision'?'保存更新':'保存配置'}</Button><Button type="button" variant="ghost" onClick={()=>void run(async()=>{await draft.snapshot();if(current())onClose();})}>稍后继续</Button><output>{draft.status}</output></footer>
    </fieldset>
   </form>
  </>}
 </section>;
}
export function ConfigurationContent({value}:{value:ConfigurationRecord}){
 const c=value?.conditions;if(!c)return null;
 const known=conditionPairs.map(([key])=>key).filter(key=>c[key]?.name||c[key]?.version),components=componentPairs.filter(([key])=>c[key]?.length);
 return <div className="configuration-content tool-reading"><p className="reading-prose">{value.summary}</p><p className="record-meta">{value.synthetic?'合成演示条件':'作者记录的条件'} · {readableTime(value.observedAt)}</p>
  {(known.length>0||components.length>0)&&<section><h2>运行条件</h2><dl className="tool-facts">{known.map(key=><React.Fragment key={key}><dt>{conditionPairs.find(([id])=>id===key)?.[1]}</dt><dd>{c[key].name??'名称未知'}{c[key].version?' · '+c[key].version:' · 版本未记录'}</dd></React.Fragment>)}{components.map(([key,label])=><React.Fragment key={key}><dt>{label}</dt><dd><ul>{c[key].map((item,index)=><li key={index}>{item.name}{item.version?' · '+item.version:' · 版本未记录'}{item.reference&&<p className="record-reference">{item.reference}</p>}</li>)}</ul></dd></React.Fragment>)}</dl></section>}
  {!known.length&&!components.length&&<p className="tool-help">没有记录具体模型、工具或环境版本。</p>}
  {(c.operationScope?.length>0||c.inputScopeSummary)&&<section><h2>可用范围</h2>{c.operationScope?.length>0&&<ul>{c.operationScope.map((value:string,index:number)=><li key={index}>{value}</li>)}</ul>}{c.inputScopeSummary&&<p className="reading-prose">{c.inputScopeSummary}</p>}</section>}
  <section><h2>限制与未知条件</h2><p className="reading-prose">{c.limitations}</p></section>
  {(c.promptPolicyVersion||c.rulesVersion||c.contentFingerprint)&&<ReadingDetails className="tool-reference"><ReadingSummary>策略版本与内容校验</ReadingSummary>{c.promptPolicyVersion&&<p>提示词策略：{c.promptPolicyVersion}</p>}{c.rulesVersion&&<p>规则：{c.rulesVersion}</p>}{c.contentFingerprint&&<code>{c.contentFingerprint}</code>}</ReadingDetails>}
 </div>;
}
function ConfigurationSubmittedContent({payload}:{payload:ConfigurationEvent}){return payload.kind==='revoke'?<p className="reading-prose">{payload.reason}</p>:<><h3>{payload.title}</h3><ConfigurationContent value={payload}/></>;}

/** This only continues a previously confirmed local journal. Reading never prepares a new write. */
export function ToolOperationStatus<P>({client,connected,scopeKey,paused=false,request=0,onComplete,renderContent}:{client:ToolJournalClient<P>;connected:boolean;scopeKey:string;paused?:boolean;request?:number;onComplete?:(receipt:ToolReceipt)=>void|Promise<void>;renderContent:(payload:P)=>React.ReactNode}){
 const [pending,setPending]=useState<ToolPending[]>([]),[review,setReview]=useState<ToolOriginal<P>|null>(null),[authorization,setAuthorization]=useState<ToolAuthorization<P>|null>(null),[reason,setReason]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[stop,setStop]=useState(false);
 const active=useRef(true),working=useRef(false),dialog=useRef<HTMLDialogElement>(null),onCompleteRef=useRef(onComplete),stateRef=useRef({paused,review,stop});
 useLayoutEffect(()=>{onCompleteRef.current=onComplete;stateRef.current={paused,review,stop};},[onComplete,paused,review,stop]);
 const notified=useRef(new Set<string>()),handledRequest=useRef(0);
 async function complete(receipt:ToolReceipt){if(receipt.state!=='acknowledged')return;if(active.current){setReview(null);setAuthorization(null);setStop(false);}if(receipt.operationId&&!notified.current.has(receipt.operationId)){notified.current.add(receipt.operationId);await onCompleteRef.current?.(receipt);}}
 async function read(){const rows=await client.pending();if(active.current)setPending(rows);return rows;}
 async function run(fn:()=>Promise<void>){if(working.current||!connected)return;working.current=true;setBusy(true);setError('');try{await fn();}catch(e){if(active.current)setError(toolError(e));}finally{try{await read();}catch{}working.current=false;if(active.current)setBusy(false);}}
 async function resume(){const state=stateRef.current;if(state.paused)return;const rows=await read(),first=rows.find(value=>value.state!=='stopped-local');if(state.review||state.stop){if(first)await complete(await client.reconcile(first.operationId));return;}const result=await client.resumePending();if(!active.current)return;setReason(result.reason??'');await complete(result);}
 async function openOriginal(){
  const rows=await read(),first=rows.find(value=>value.state!=='stopped-local');if(!first)return;
  const receipt=await client.reconcile(first.operationId);if(!active.current)return;if(receipt.state==='acknowledged'){await complete(receipt);return;}
  const original=await client.reviewPending(first.operationId);if(!active.current)return;if(original.localRetryStopped){await read();return;}setReview(original);setAuthorization(null);setStop(false);
  const token=await client.reviewAuthorization(first.operationId);if(!active.current)return;if(token.state==='acknowledged'){await complete(token);return;}if(toolAuthorization(token))setAuthorization(token);else if(token.reason)setReason(token.reason);
 }
 const tickCurrent=useEffectEvent(()=>{if(!document.hidden)void run(resume);});
 useEffect(()=>{active.current=true;const tick=()=>tickCurrent();tick();const timer=setInterval(tick,12000);document.addEventListener('visibilitychange',tick);return()=>{active.current=false;clearInterval(timer);document.removeEventListener('visibilitychange',tick);};},[client,connected,scopeKey]);
 const openRequested=useEffectEvent(()=>{if(request&&request!==handledRequest.current&&!busy&&!paused&&!working.current){handledRequest.current=request;void run(openOriginal);}});
 useEffect(()=>{openRequested();},[request,busy,paused]);
 useEffect(()=>{if(review)dialog.current?.showModal();else dialog.current?.close();},[review]);
 const first=pending.find(value=>value.state!=='stopped-local'),stopped=pending.filter(value=>value.state==='stopped-local');
 const explanation=reason==='authorization-deadline-invalid'?'原授权期限无法使用，核对本次期限后继续。':reason==='authorization-expired'?'原授权已到期。原内容保留，继续前需要核对新期限。':reason==='original-binding-changed'||reason==='original-binding-unavailable'?'连接已变化。原内容保留，继续前需要核对授权。':'上次提交还在确认，正在沿原操作接续。';
 if(!first&&!stopped.length&&!error&&!review)return null;
 return <aside className="tool-operation" aria-label="原提交状态">
  {first&&<><p>{explanation}</p><button className="text-link" disabled={busy||paused} onClick={()=>void run(openOriginal)}>查看原提交</button></>}
  {stopped.length>0&&<ReadingDetails className="tool-reference"><ReadingSummary>已停止重试的提交</ReadingSummary><p>这些记录只查询原接收状态，不再发送已移除的内容。</p>{stopped.map(value=><p key={value.operationId}><code>{value.operationId}</code></p>)}</ReadingDetails>}
  {error&&<p role="alert" className="message error">{error}</p>}
  <dialog ref={dialog} className="workspace-dialog tool-dialog" onCancel={e=>{if(busy)e.preventDefault();else{setReview(null);setAuthorization(null);setStop(false);}}}>{review&&<>
   <header className="dialog-heading"><h2>{stop?'停止这次重试':'原提交内容'}</h2><button className="icon-button" disabled={busy} aria-label="关闭原提交" onClick={()=>{setReview(null);setAuthorization(null);setStop(false);}}><X size={19}/></button></header>
   {stop?<p>停止后移除本机待发原文，只查询是否已接收。已经发生的保存不会因此撤回。</p>:<>{renderContent(review.payload)}<p className="tool-help">{review.visibility==='Public'?'公开这些选定内容':review.viewers?.length?'仅本人及 '+review.viewers.map((id:string)=>memberName(id)).join('、')+'可读':'仅本人可读'}。</p><p className="tool-help">原授权期限：{review.expiresAt!==null&&Number.isSafeInteger(review.expiresAt)?new Date(review.expiresAt*1000).toLocaleString('zh-CN'):'旧记录未保留准确期限'}{authorization&&authorization.expiresAt!==review.expiresAt&&<>；这次授权至 {new Date(authorization.expiresAt*1000).toLocaleString('zh-CN')}</>}。</p></>}
   {error&&<p className="message error" role="alert">{error}</p>}
   <div className="tool-actions">{stop?<><Button disabled={busy} onClick={()=>void run(async()=>{await complete(await client.stopLocalRetry(review.operationId,{confirmed:true}));if(active.current){setReview(null);setAuthorization(null);setStop(false);}})}>停止原操作重试</Button><Button variant="outline" disabled={busy} onClick={()=>setStop(false)}>继续保留</Button></>:<>{authorization?<Button disabled={busy} onClick={()=>void run(async()=>{const result=await client.reauthorize(authorization.operationId,authorization,{confirmed:true});await complete(result);if(active.current&&result.state!=='acknowledged')setReason(result.reason??'');})}>按此内容重新授权并继续</Button>:<Button disabled={busy} onClick={()=>void run(async()=>{setReview(null);setAuthorization(null);const result=await client.resumePending();if(active.current)setReason(result.reason??'');await complete(result);})}>继续原提交</Button>}<Button variant="ghost" disabled={busy} onClick={()=>setStop(true)}>停止重试</Button></>}</div>
   {!stop&&<ReadingDetails className="tool-reference"><ReadingSummary>准确操作引用</ReadingSummary><p><code>{review.operationId}</code></p><p><code>{review.payloadHash}</code></p></ReadingDetails>}
  </>}</dialog>
 </aside>;
}
