import React,{useCallback,useEffect,useEffectEvent,useId,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {ArrowLeft,ChevronDown,Plus,Trash2} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {createProfileEditorClient} from './profile-editor-client.mjs';
import {createGovernanceDraftState} from './governance-draft-state';
import {MemberAvatar,memberName,useMemberNames} from './conversation-ui';
import type {AccountRuntime,ProfileDeclaration as Declaration,ProfileOwnerView as ProfileOwner,ProfileStatementLocator as ProfileLocator,ProfileSaveResult as ProfileResult,ProfilePending,ProfileAuthorizationReview} from './account-workspace-types';

type ProfileProject=NonNullable<Declaration['projects']>[number];
type ProjectInput=Omit<ProfileProject,'functions'|'technologies'>&{functions:string;technologies:string};
type ProfileValues={displayName:string;about:string;directions:string;projects:ProjectInput[];visibility:'Private'|'Public';viewers:string[];expiresAt:number|null};
type ProfileDraft={base:{revision:number;values:ProfileValues};values:ProfileValues};
type ProfileClient=ReturnType<typeof createProfileEditorClient>;
type Props={runtime:AccountRuntime;subjectId:string;connected:boolean;onClose:()=>void;onSaved:()=>void;onNeedIdentity:()=>void};
type PeopleKind='contacts'|'rooms';
type Person={subjectId:string;displayName:string|null;source:string};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const tags=(value:string)=>[...new Set(value.split(/[,，、\n]+/).map(item=>item.trim()).filter(Boolean))];
const localTime=(seconds:number)=>{const date=new Date(seconds*1000);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,19);};
const readableTime=(seconds:number)=>new Date(seconds*1000).toLocaleString('zh-CN',{year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'});
function profileError(error:unknown){const value=error as {code?:string;message?:string},code=value?.code??value?.message;return ({profile_revision_conflict:'资料已在别处更新。本页修改仍保留，请核对最新内容。',profile_identity_changed:'使用中的身份或连接已变化。原输入仍保留，请重新连接后继续。',profile_editor_identity_changed:'使用中的身份或连接已变化。原输入仍保留，请重新连接后继续。',profile_statement_conflict:'刚才保存的内容需要重新核对，原输入仍保留。',consent_reauthorization_required:'这次保存的使用授权已结束，请核对原内容后继续。',invalid_profile_statement:'请检查介绍和项目内容是否填写完整。'} as Record<string,string>)[code??'']??(value?.message&&/[\u3400-\u9fff]/.test(value.message)?value.message:'暂时未能完成。已输入的内容保留在本机，可在连接恢复后继续。');}
function valuesFromOwner(owner:ProfileOwner):ProfileValues{return {displayName:owner.selfDeclared.displayName??'',about:owner.selfDeclared.about??'',directions:(owner.selfDeclared.claimedCapabilities??[]).join('，'),projects:(owner.selfDeclared.projects??[]).map(item=>({...item,functions:item.functions.join('，'),technologies:item.technologies.join('，'),discoverable:item.discoverable??false})),visibility:owner.sharing?.visibility??'Private',viewers:owner.sharing?.viewers??[],expiresAt:owner.sharing?.expiresAt??null};}
function draftFromOwner(owner:ProfileOwner):ProfileDraft{const values=valuesFromOwner(owner);return {base:{revision:owner.revision,values:structuredClone(values)},values};}
function isValues(value:unknown):value is ProfileValues{if(!value||typeof value!=='object')return false;const input=value as ProfileValues;return typeof input.displayName==='string'&&typeof input.about==='string'&&typeof input.directions==='string'&&Array.isArray(input.projects)&&input.projects.every(project=>project&&typeof project.id==='string'&&['project','module'].includes(project.kind)&&typeof project.title==='string'&&typeof project.summary==='string'&&typeof project.functions==='string'&&typeof project.technologies==='string'&&typeof project.discoverable==='boolean'&&(project.sourceUrl===undefined||typeof project.sourceUrl==='string'))&&Array.isArray(input.viewers)&&input.viewers.every(person=>typeof person==='string')&&['Private','Public'].includes(input.visibility)&&(input.expiresAt===null||Number.isSafeInteger(input.expiresAt)&&input.expiresAt>0);}
function isDraft(value:unknown):value is ProfileDraft{if(!value||typeof value!=='object')return false;const input=value as ProfileDraft;return !!input.base&&Number.isInteger(input.base.revision)&&input.base.revision>=0&&isValues(input.base.values)&&isValues(input.values);}
function declaration(values:ProfileValues):Declaration{
 const directions=tags(values.directions);if(directions.length>20||directions.some(value=>value.length>100))throw Error('关注与参与方向最多 20 项，每项不超过 100 个字。');
 const projects=values.projects.map(project=>{const title=project.title.trim(),summary=project.summary.trim(),functions=tags(project.functions),technologies=tags(project.technologies),sourceUrl=project.sourceUrl?.trim();
  if(!title||!summary)throw Error('请补全每个项目的名称与介绍。');
  if(project.discoverable&&!functions.length)throw Error('请为允许发现的项目填写内容与涉及方向。');
  if(functions.length>16||technologies.length>16||[...functions,...technologies].some(value=>value.length>80))throw Error('项目的用途和技术各最多 16 项，每项不超过 80 个字。');
  if(sourceUrl){let url:URL;try{url=new URL(sourceUrl);}catch{throw Error('请使用有效的 https 项目链接。');}if(url.protocol!=='https:'||url.username||url.password)throw Error('请使用不含账号或密码的 https 项目链接。');}
  return {...project,title,summary,functions,technologies,sourceUrl:sourceUrl||undefined};
 });return {displayName:values.displayName.trim(),about:values.about.trim(),claimedCapabilities:directions,projects};
}

function PeoplePicker({runtime,client,subjectId,value,onChange,disabled}:{runtime:AccountRuntime;client:ProfileClient;subjectId:string;value:string[];onChange:(ids:string[])=>void;disabled:boolean}){
 const [people,setPeople]=useState<Person[]>([]),[next,setNext]=useState<Partial<Record<PeopleKind,string|null>>>({}),[loading,setLoading]=useState(true),[errors,setErrors]=useState<Partial<Record<PeopleKind,boolean>>>({}),[query,setQuery]=useState('');
 const control=useRef({alive:true,reading:new Set<PeopleKind>(),seen:new Set<string>()}),fieldId=useId();
 const ids=[...new Set([...value,...people.map(person=>person.subjectId)])].filter(id=>id!==subjectId),names=useMemberNames(runtime,subjectId,true,ids);
 const load=useCallback(async(kind:PeopleKind,after?:string)=>{const state=control.current;if(state.reading.has(kind)||!state.alive)return;state.reading.add(kind);
  try{if(after&&state.seen.has(kind+':'+after))throw Error('联系人列表暂时不能继续，已有选择仍保留。');const page=await client.peoplePage(kind,{after});if(!state.alive)return;if(after)state.seen.add(kind+':'+after);setPeople(old=>[...new Map([...old,...page.items].map(person=>[person.subjectId,person])).values()]);setNext(old=>({...old,[kind]:page.next}));setErrors(old=>({...old,[kind]:false}));}
  catch{if(state.alive)setErrors(old=>({...old,[kind]:true}));}
  finally{state.reading.delete(kind);if(state.alive)setLoading(state.reading.size>0);}
 },[client]);
 useEffect(()=>{const state=control.current;state.alive=true;void Promise.resolve().then(()=>Promise.all([load('contacts'),load('rooms')]));return()=>{state.alive=false;};},[load]);
 const error=Object.values(errors).some(Boolean)?'部分联系人暂时未读到，已有选择仍保留。':'',name=(id:string)=>memberName(id,subjectId,names[id]??undefined);
 return <div className="person-audience-picker">{ids.length>6&&<label htmlFor={fieldId}>查找联系人<Input id={fieldId} type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="输入姓名" disabled={disabled}/></label>}
  <div className="person-audience-people">{ids.filter(id=>value.includes(id)||name(id).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(id=><label key={id}><input type="checkbox" checked={value.includes(id)} disabled={disabled||!value.includes(id)&&value.length>=16} onChange={event=>onChange(event.target.checked?[...value,id]:value.filter(person=>person!==id))}/><MemberAvatar subjectId={id}/><span>{name(id)}</span></label>)}</div>
  {loading&&<output>正在读取联系人…</output>}{!loading&&!ids.length&&!error&&<p className="person-muted">还没有可选择的联系人。未选择其他人时，仅自己可见。</p>}
  {error&&<p className="person-read-error" role="alert">{error}<button type="button" disabled={disabled||loading} onClick={()=>{setLoading(true);void Promise.all([load('contacts'),load('rooms')]);}}>重新读取</button></p>}
  {next.contacts&&<Button type="button" variant="ghost" disabled={disabled||loading} onClick={()=>{setLoading(true);void load('contacts',next.contacts!);}}>更多联系人</Button>}{next.rooms&&<Button type="button" variant="ghost" disabled={disabled||loading} onClick={()=>{setLoading(true);void load('rooms',next.rooms!);}}>更早对话中的人</Button>}
 </div>;
}

function ProjectEditor({value,onChange,onRemove,index}:{value:ProjectInput;onChange:(value:ProjectInput)=>void;onRemove:()=>void;index:number}){
 const [expanded,setExpanded]=useState(!value.title),[technical,setTechnical]=useState(!!value.technologies||!!value.functions||value.discoverable),fieldId=useId();
 const change=(patch:Partial<ProjectInput>)=>onChange({...value,...patch});
 return <article className="person-project-editor"><header><button type="button" className="person-project-toggle" aria-expanded={expanded} onClick={()=>setExpanded(old=>!old)}><span>{value.title||'新项目介绍'}<small>{value.kind==='module'?'可复用模块':'项目'}{!expanded&&value.summary?' · '+value.summary.slice(0,75):''}</small></span><ChevronDown size={18}/></button><button type="button" className="person-project-remove" aria-label={'移除'+(value.title||'项目介绍 '+(index+1))} onClick={onRemove}><Trash2 size={16}/><span>移除</span></button></header>
  <div hidden={!expanded} className="person-project-fields" onInvalidCapture={event=>{if(!expanded){event.preventDefault();const field=event.target as HTMLInputElement|HTMLTextAreaElement;setExpanded(true);requestAnimationFrame(()=>{field.focus();field.reportValidity();});}}}>
   <div className="person-project-title"><label htmlFor={fieldId+'-title'}>名称<Input id={fieldId+'-title'} aria-label={'项目 '+(index+1)+' 名称'} required value={value.title} maxLength={120} onChange={event=>change({title:event.target.value})}/></label><label>类型<select aria-label={'项目 '+(index+1)+' 类型'} value={value.kind} onChange={event=>change({kind:event.target.value==='module'?'module':'project'})}><option value="project">作品或项目</option><option value="module">可复用模块</option></select></label></div>
   <label htmlFor={fieldId+'-summary'}>介绍<Textarea id={fieldId+'-summary'} aria-label={'项目 '+(index+1)+' 介绍'} required rows={4} value={value.summary} maxLength={2000} onChange={event=>change({summary:event.target.value})} placeholder="介绍作品的内容、当前进展，以及你在其中做的事。"/></label>
   <label htmlFor={fieldId+'-url'}>项目链接<span className="person-field-optional">可选</span><Input id={fieldId+'-url'} aria-label={'项目 '+(index+1)+' 链接'} type="url" value={value.sourceUrl??''} maxLength={2048} onChange={event=>change({sourceUrl:event.target.value})} placeholder="https://…"/></label>
   <label className="person-checkbox"><input type="checkbox" checked={value.discoverable} onChange={event=>{change({discoverable:event.target.checked});if(event.target.checked)setTechnical(true);}}/><span>允许按内容方向发现这份作品<small>遵循下方资料范围，并沿用你的发现设置。</small></span></label>
   {!technical&&<button type="button" className="text-link" onClick={()=>setTechnical(true)}>补充内容方向与工具</button>}
   {technical&&<><label htmlFor={fieldId+'-functions'}>内容与涉及方向{!value.discoverable&&<span className="person-field-optional">可选</span>}<Input id={fieldId+'-functions'} aria-label={'项目 '+(index+1)+' 内容与涉及方向'} required={value.discoverable} value={value.functions} onChange={event=>change({functions:event.target.value})} placeholder="用逗号分隔，例如：整理资料，协作编辑"/></label><label htmlFor={fieldId+'-technologies'}>使用的工具与技术<span className="person-field-optional">可选</span><Input id={fieldId+'-technologies'} aria-label={'项目 '+(index+1)+' 使用的工具与技术'} value={value.technologies} onChange={event=>change({technologies:event.target.value})} placeholder="用逗号分隔"/></label></>}
  </div>
 </article>;
}

const groups=['displayName','about','directions','projects','sharing'] as const;
type ConflictGroup=typeof groups[number];
const groupTitles:Record<ConflictGroup,string>={displayName:'称呼',about:'个人介绍',directions:'关注与参与方向',projects:'项目介绍',sharing:'资料分享范围'};
const groupValue=(values:ProfileValues,group:ConflictGroup)=>group==='sharing'?{visibility:values.visibility,viewers:values.viewers,expiresAt:values.expiresAt}:values[group];
function changedGroups(base:ProfileValues,mine:ProfileValues,latest:ProfileValues){return groups.filter(group=>!same(groupValue(mine,group),groupValue(latest,group))&&(!same(groupValue(mine,group),groupValue(base,group))||!same(groupValue(latest,group),groupValue(base,group))));}
function mergedValues(base:ProfileValues,mine:ProfileValues,latest:ProfileValues):ProfileValues{const merged=structuredClone(mine);for(const group of groups)if(same(groupValue(mine,group),groupValue(base,group))){if(group==='sharing'){merged.visibility=latest.visibility;merged.viewers=[...latest.viewers];merged.expiresAt=latest.expiresAt;}else if(group==='projects')merged.projects=structuredClone(latest.projects);else merged[group]=latest[group];}return merged;}
function DifferenceValue({value,group,subjectId,names}:{value:ProfileValues;group:ConflictGroup;subjectId:string;names:Record<string,string|null>}){
 if(group==='projects')return value.projects.length?<ul>{value.projects.map(project=><li key={project.id}><strong>{project.title||'未命名项目'} · {project.kind==='module'?'可复用模块':'项目'}</strong><p>{project.summary||'未填写介绍'}</p>{project.sourceUrl&&<p>{project.sourceUrl}</p>}{project.functions&&<p>用途：{project.functions}</p>}{project.technologies&&<p>技术：{project.technologies}</p>}<p>{project.discoverable?'允许按用途发现':'未加入用途发现'}</p></li>)}</ul>:<p>没有项目介绍</p>;
 if(group==='sharing')return <p>{value.visibility==='Public'?'公开':value.viewers.length?'自己和 '+value.viewers.map(id=>memberName(id,subjectId,names[id]??undefined)).join('、'):'仅自己'}<br/>{value.expiresAt?'可查看至 '+readableTime(value.expiresAt):'持续展示，直到修改分享范围'}</p>;
 return <p>{value[group]||'未填写'}</p>;
}

export function PersonProfileEditor(props:Props){
 const {runtime,subjectId,connected,onClose,onNeedIdentity}=props;
 const client=useMemo(()=>connected?createProfileEditorClient(runtime,{subjectId}):null,[runtime,subjectId,connected]);
 const draftKey='person-profile-input:v1:'+JSON.stringify([runtime.api.endpoint,subjectId]);
 const [owner,setOwner]=useState<ProfileOwner|null>(null),[savedDraft,setSavedDraft]=useState<ProfileDraft|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(!!client),[localReady,setLocalReady]=useState(false),[retry,setRetry]=useState(0),[startFresh,setStartFresh]=useState(false);
 useEffect(()=>{let active=true;if(!client)return;
  void Promise.allSettled([client.ownerRead(),runtime.getLocal(draftKey,subjectId)]).then(results=>{if(!active)return;const [current,local]=results;
   if(current.status==='fulfilled'){setOwner(current.value);setError('');}else setError(profileError(current.reason));
   if(local.status==='fulfilled'){const envelope=local.value as {value?:unknown}|null;if(envelope&&!isDraft(envelope.value)){setError('本机原稿暂时无法读取。请保留原稿，暂不覆盖资料。');setLocalReady(false);}else{setSavedDraft(envelope?.value as ProfileDraft??null);setLocalReady(true);}}
   else{setError('本机原稿暂时无法读取，请稍后重试。');setLocalReady(false);}setLoading(false);
  });return()=>{active=false;};
 },[client,runtime,subjectId,draftKey,retry]);
 useEffect(()=>()=>client?.close(),[client]);
 const initial=owner?draftFromOwner(owner):savedDraft;
 const available=localReady&&!!initial&&(!!savedDraft||owner?.readable||owner?.revision===0||startFresh);
 return <article className="person-profile person-edit"><button type="button" className="person-return" onClick={onClose}><ArrowLeft size={16}/>返回个人资料</button><header className="person-edit-heading"><h1>编辑个人资料</h1><p>让别人认识你，以及你关注和参与的事情。</p></header>
  {!connected?<div className="person-edit-recovery"><p>使用本人的身份后，可以继续编辑这份资料。</p><Button onClick={onNeedIdentity}>继续使用我的身份</Button></div>:<>
   {loading&&!available&&<output>正在读取本人资料和本机草稿…</output>}
   {error&&<p className="person-read-error" role="alert">{error}<button type="button" onClick={()=>{setLoading(true);setRetry(value=>value+1);}}>重新读取</button></p>}
   {!loading&&localReady&&owner&&!owner.readable&&owner.revision>0&&!available&&<div className="person-edit-recovery"><h2>原资料当前不可读取</h2><p>{owner.sharing?.status==='expired'?'原来的分享已到期。':owner.sharing?.status==='revoked'?'原来的分享已停止。':'原内容暂时没有向当前身份开放。'}重新填写并保存后，将以新的介绍和分享范围展示。</p><Button onClick={()=>setStartFresh(true)}>重新填写资料</Button></div>}
   {available&&client&&initial&&<ProfileEditorForm {...props} client={client} draftKey={draftKey} initial={initial} serverOwner={owner}/>}
  </>}
 </article>;
}

function ProfileEditorForm({runtime,subjectId,client,draftKey,initial,serverOwner,onClose,onSaved}:Props&{client:ProfileClient;draftKey:string;initial:ProfileDraft;serverOwner:ProfileOwner|null}){
 const [store,setStore]=useState(()=>createGovernanceDraftState<ProfileDraft,ProfileLocator>(runtime,subjectId,true,draftKey,initial,profileError)),draft=useSyncExternalStore(store.subscribe,store.read,store.read);
 const lease=useMemo(()=>runtime.receiptStatus.captureLease(),[runtime]),control=useRef({alive:true,working:false,completed:false}),fieldId=useId();
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[pending,setPending]=useState<ProfilePending|null>(null),[conflict,setConflict]=useState<ProfileOwner|null>(null),[pendingReady,setPendingReady]=useState(false),[authorizationReview,setAuthorizationReview]=useState<ProfileAuthorizationReview|null>(null),[continuationReason,setContinuationReason]=useState('');
 const [localConflict,setLocalConflict]=useState<{revision:string|null;value:ProfileDraft}|null>(null);
 const valid=isDraft(draft.value),input=valid?draft.value:initial,values=input.values;
 const names=useMemberNames(runtime,subjectId,true,[...new Set([...values.viewers,...(conflict?.sharing?.viewers??[]),...(pending?.viewers??[]),...(localConflict?.value.values.viewers??[])])]);
 const current=useCallback(()=>{try{lease.assertCurrent();return control.current.alive;}catch{return false;}},[lease]);
 useEffect(()=>{const state=control.current;state.alive=true;void store.start();return()=>{state.alive=false;store.close();};},[store]);
 function change(patch:Partial<ProfileValues>){setError('');store.change({values:{...values,...patch}});}
 async function finish(result:ProfileResult){
  if(!current()||control.current.completed)return;
  if(result.state==='acknowledged'){
   await store.settle(locator=>client.receiptFor(locator));if(!current())return;control.current.completed=true;setPending(null);onSaved();return;
  }
   const original=await client.pending();if(!current())return;setPending(original);setContinuationReason(result.reason??'');setAuthorizationReview(null);
  if(result.reason==='profile_revision_conflict'||result.state==='conflict'){
   const latest=await client.ownerRead();if(!current())return;setConflict(latest);setError('资料已在别处更新，本页修改仍保留。');
  }else if(result.state!=='idle'){
   if(['consent_reauthorization_required','authorization-expired','authorization-unavailable','binding-changed'].includes(result.reason??'')){
     const review=await client.reviewAuthorization();if(!current())return;
     if(review.state==='reauthorization-required'||review.state==='reuse-original-authorization'){setAuthorizationReview(review);setError('这次保存的使用授权已变化。原内容和分享范围保留，核对后可以继续。');}
     else await finish({...review,state:review.state});
   }else setError(result.reason==='sharing-expired'?'本次选择的分享时间已结束。可以保留输入，返回修改分享范围后再保存。':'正在核对刚才的保存。原输入仍保留，可以先返回资料。');
  }
 }
 async function run(action:()=>Promise<void>){if(control.current.working||!current())return;control.current.working=true;setBusy(true);setError('');try{lease.assertCurrent();await action();}
   catch(reason){if(current()){setError(profileError(reason));const code=(reason as {code?:string;message?:string})?.code??(reason as Error)?.message;if(code==='profile_review_changed'||code==='profile_operation_changed'){setAuthorizationReview(null);setContinuationReason('');}if(code==='profile_revision_conflict'){try{const latest=await client.ownerRead();if(current())setConflict(latest);}catch{}}try{const original=await client.pending();if(current())setPending(original);}catch{}}}
  finally{control.current.working=false;if(current())setBusy(false);}
 }
 async function resume(explicitRetry=false){
  if(control.current.working||control.current.completed||!current()||conflict&&!explicitRetry)return;control.current.working=true;
  try{const original=await client.pending();if(!current())return;setPending(original);setPendingReady(true);
   if(original){setBusy(true);await finish(await client.resumePending({explicitRetry}));return;}
   if(draft.attempt){const result=await client.receiptFor(draft.attempt);if(result.state==='acknowledged')await finish(result);}
  }catch(reason){if(current())setError(profileError(reason));}
  finally{control.current.working=false;if(current())setBusy(false);}
 }
 const resumeOnTick=useEffectEvent(()=>resume());
 useEffect(()=>{if(!draft.ready)return;void Promise.resolve().then(()=>resumeOnTick());const tick=()=>{if(!document.hidden&&!control.current.working&&!control.current.completed)void resumeOnTick();};const timer=window.setInterval(tick,12000);window.addEventListener('online',tick);document.addEventListener('visibilitychange',tick);return()=>{window.clearInterval(timer);window.removeEventListener('online',tick);document.removeEventListener('visibilitychange',tick);};},[draft.ready]);
 async function save(){await run(async()=>{
  let snapshot=await store.snapshot();if(!snapshot.revision){store.change(snapshot.value);snapshot=await store.snapshot();}lease.assertCurrent();
  const value=snapshot.value.values;
  if(value.expiresAt!==null&&value.expiresAt<=Date.now()/1000)throw Error('原来的分享已到期。请选择持续展示，或设置新的结束时间。');
  const latest=await client.ownerRead();if(!current())return;
  if(latest.revision!==snapshot.value.base.revision){setConflict(latest);setError('资料已在别处更新，本页修改仍保留。');return;}
  const result=await client.save({expectedRevision:snapshot.value.base.revision,selfDeclared:declaration(value),visibility:value.visibility,viewers:value.visibility==='Public'?[]:value.viewers,expiresAt:value.expiresAt},{onJournal:async(locator:ProfileLocator)=>{lease.assertCurrent();await store.attach(locator,snapshot.revision);lease.assertCurrent();}});
  await finish(result);
 });}
 async function cancel(){await run(async()=>{if(draft.status.includes('另一页已修改')){onClose();return;}const snapshot=await store.snapshot();lease.assertCurrent();await runtime.updateLocal(draftKey,(raw:unknown)=>{lease.assertCurrent();const old=raw as {revision?:string;attempt?:ProfileLocator}|null;if((old?.revision??null)!==snapshot.revision)throw Error('另一页已更新本机草稿，已保留那一页的内容。');if(old?.attempt)throw Error('刚才的保存还在核对中，可以先返回个人资料。');return null;},subjectId);if(current())onClose();});}
 async function stopForEditing(){if(!pending)return;await run(async()=>{const result=await client.stopPending(pending);if(result.state==='acknowledged'){await finish(result);return;}if(result.state!=='absent')throw Error('刚才的保存暂时无法确定，原内容仍保留。');const snapshot=await store.snapshot();store.change(snapshot.value);await store.snapshot();if(!current())return;setPending(null);setAuthorizationReview(null);setContinuationReason('');setError('原来的保存已停止。请修改分享范围，再保存本页内容。');});}
 async function readOtherDraft(){await run(async()=>{const raw=await runtime.getLocal(draftKey,subjectId) as {revision?:string;value?:unknown}|null;lease.assertCurrent();if(raw){if(typeof raw.revision!=='string'||!isDraft(raw.value))throw Error('另一页的草稿暂时无法读取，本页输入仍保留。');if(current())setLocalConflict({revision:raw.revision,value:raw.value});}
  else{const latest=await client.ownerRead();if(!current())return;if(!latest.readable&&latest.revision>0)throw Error('已保存的最新资料暂不可读取，本页修改仍保留。');setLocalConflict({revision:null,value:draftFromOwner(latest)});}
 });}
 async function resolveLocalDraft(choice:'mine'|'other'){if(!localConflict)return;await run(async()=>{
  const original=await client.pending();if(original){if(current())setPending(original);throw Error('另一页的保存仍在核对中，暂时保留两边输入。');}
  const next:ProfileDraft={base:structuredClone(localConflict.value.base),values:choice==='other'?structuredClone(localConflict.value.values):mergedValues(input.base.values,values,localConflict.value.values)};
  await runtime.updateLocal(draftKey,(raw:unknown)=>{lease.assertCurrent();const existing=raw as {revision?:string}|null;if((existing?.revision??null)!==localConflict.revision)throw Error('另一页的草稿又有变化，请重新读取后核对。');return {version:1,revision:crypto.randomUUID(),value:next};},subjectId);lease.assertCurrent();if(!current())return;
  setStore(createGovernanceDraftState<ProfileDraft,ProfileLocator>(runtime,subjectId,true,draftKey,next,profileError));setLocalConflict(null);setConflict(null);setError('');setPendingReady(false);
 });}
 async function resolveConflict(choice:'latest'|'mine'){if(!conflict)return;await run(async()=>{
  if(!conflict.readable&&conflict.revision>0)throw Error('最新内容暂不可读取，尚不能安全合并。本页修改仍保留。');
  const fresh=await client.ownerRead();if(!current())return;if(fresh.revision!==conflict.revision){setConflict(fresh);throw Error('最新资料又有变化，请继续核对。');}
  if(pending){const stopped=await client.stopPending(pending);if(stopped.state==='acknowledged'){await finish(stopped);return;}if(stopped.state!=='absent')throw Error('刚才的保存还无法准确核对，原内容仍保留。');if(!current())return;}
  const latest=valuesFromOwner(fresh),snapshot=await store.snapshot(),next=choice==='latest'?latest:mergedValues(snapshot.value.base.values,snapshot.value.values,latest);
  store.change({base:{revision:fresh.revision,values:structuredClone(latest)},values:next});await store.snapshot();if(!current())return;setPending(null);setConflict(null);setAuthorizationReview(null);setError('');
 });}
 const draftElsewhere=draft.status.includes('另一页已修改'),disabled=busy||!draft.ready||!pendingReady||!valid||!!pending&&!conflict;
 const latest=conflict?valuesFromOwner(conflict):null,differences=latest?changedGroups(input.base.values,values,latest):[];
 const sharingExpired=continuationReason==='sharing-expired',pendingValues:ProfileValues|null=pending?{displayName:pending.payload.selfDeclared.displayName??'',about:pending.payload.selfDeclared.about??'',directions:(pending.payload.selfDeclared.claimedCapabilities??[]).join('，'),projects:(pending.payload.selfDeclared.projects??[]).map(item=>({...item,functions:item.functions.join('，'),technologies:item.technologies.join('，')})),visibility:pending.visibility,viewers:pending.viewers,expiresAt:pending.expiresAt}:null;
 return <>
  {(draftElsewhere||localConflict)&&<section className="person-edit-recovery" aria-label="核对本机草稿"><h2>另一页也修改了这份草稿</h2><p>{localConflict?'两边输入都保留在下方，核对后继续。保留本页修改时，未修改的部分会沿用另一页的内容。':'本页输入仍保留。读取另一页的内容后，选择如何继续。'}</p>{localConflict&&<div className="person-profile-differences">{changedGroups(input.base.values,values,localConflict.value.values).map(group=><section key={group}><h3>{groupTitles[group]}</h3><div><div><h4>另一页的内容</h4><DifferenceValue value={localConflict.value.values} group={group} subjectId={subjectId} names={names}/></div><div><h4>本页内容</h4><DifferenceValue value={values} group={group} subjectId={subjectId} names={names}/></div></div></section>)}</div>}<div className="button-row">{localConflict&&<><Button disabled={busy} onClick={()=>void resolveLocalDraft('mine')}>保留本页修改</Button><Button variant="outline" disabled={busy} onClick={()=>void resolveLocalDraft('other')}>采用另一页内容</Button></>}<Button variant={localConflict?'ghost':'outline'} disabled={busy} onClick={()=>void readOtherDraft()}>{localConflict?'重新读取':'核对另一页内容'}</Button></div></section>}
  {conflict&&<section className="person-edit-recovery" aria-label="核对资料更新"><h2>资料在别处有了更新</h2><p>下方保留最新内容和本页修改。继续本页修改时，未修改的部分会沿用最新资料。</p>
   {!conflict.readable&&conflict.revision>0?<p>最新资料目前不可读取，暂时不能合并。本页修改仍保留。</p>:latest&&<div className="person-profile-differences">{differences.map(group=><section key={group}><h3>{groupTitles[group]}</h3><div><div><h4>最新资料</h4><DifferenceValue value={latest} group={group} subjectId={subjectId} names={names}/></div><div><h4>本页内容</h4><DifferenceValue value={values} group={group} subjectId={subjectId} names={names}/></div></div></section>)}</div>}
   <div className="button-row"><Button disabled={busy||!conflict.readable&&conflict.revision>0} onClick={()=>void resolveConflict('mine')}>继续本页修改</Button><Button variant="outline" disabled={busy||!conflict.readable&&conflict.revision>0} onClick={()=>void resolveConflict('latest')}>采用最新资料</Button><Button variant="ghost" disabled={busy} onClick={()=>void run(async()=>{const value=await client.ownerRead();if(current())setConflict(value);})}>重新读取</Button></div>
  </section>}
  {pending&&!conflict&&<section className="person-edit-recovery" aria-label="继续刚才的保存"><h2>{sharingExpired?'本次分享时间已结束':authorizationReview?'继续保存原来的内容':'正在核对刚才的保存'}</h2><p>{sharingExpired?'原内容仍在，可以修改实际分享范围后再保存。':'本次提交会继续使用原来的内容与分享范围，核对期间不会另存一份。'}</p>{pendingValues&&<details><summary>本次保存的内容</summary>{groups.map(group=><section key={group}><h3>{groupTitles[group]}</h3><DifferenceValue value={pendingValues} group={group} subjectId={subjectId} names={names}/></section>)}</details>}<div className="button-row"><Button disabled={busy} onClick={()=>sharingExpired?void stopForEditing():authorizationReview?void run(async()=>finish(await client.reauthorize(authorizationReview,{confirmed:true}))):void resume(true)}>{busy?'正在核对…':sharingExpired?'返回修改分享范围':authorizationReview?'继续保存原内容':'重新核对并继续'}</Button><Button variant="ghost" onClick={onClose}>先返回资料</Button></div></section>}
  {error&&<p role="alert" className="person-read-error">{error}{!pendingReady&&<button type="button" disabled={busy} onClick={()=>void resume(true)}>重试</button>}</p>}
  {!valid&&<p role="alert">原稿内容暂时无法读取，未覆盖现有资料。</p>}
  {serverOwner&&!serverOwner.readable&&serverOwner.revision>0&&!conflict&&<p className="person-muted">原资料当前不可读取。下方保留的是本机内容；保存后将按本次选择展示。</p>}
  <form className="person-edit-form" onSubmit={event=>{event.preventDefault();void save();}}><fieldset disabled={disabled}>
   <section aria-label="本人介绍"><label htmlFor={fieldId+'-name'}>称呼<Input id={fieldId+'-name'} aria-label="称呼" value={values.displayName} maxLength={100} onChange={event=>change({displayName:event.target.value})} autoComplete="nickname" placeholder="你希望别人怎样称呼你"/></label><label htmlFor={fieldId+'-about'}>个人介绍<Textarea id={fieldId+'-about'} aria-label="个人介绍" value={values.about} maxLength={2000} rows={7} onChange={event=>change({about:event.target.value})} placeholder="介绍你正在做的事、关注的问题，或希望与别人交流的内容。"/></label><div className="person-edit-directions"><label htmlFor={fieldId+'-directions'}>关注与参与方向<span className="person-field-optional">可选</span><Input id={fieldId+'-directions'} aria-label="关注与参与方向" value={values.directions} onChange={event=>change({directions:event.target.value})} placeholder="用逗号分隔，例如：知识整理，开源协作"/></label></div></section>
   <section className="person-edit-projects"><header><h2>项目介绍</h2><span className="person-muted">可选</span></header><p className="person-muted">介绍做过或正在做的项目，附上可查看的链接。</p>{values.projects.map((project,index)=><ProjectEditor key={project.id} index={index} value={project} onChange={value=>change({projects:values.projects.map(item=>item.id===value.id?value:item)})} onRemove={()=>change({projects:values.projects.filter(item=>item.id!==project.id)})}/>)}{values.projects.length<10&&<Button type="button" variant="outline" onClick={()=>change({projects:[...values.projects,{id:crypto.randomUUID(),kind:'project',title:'',summary:'',functions:'',technologies:'',discoverable:false}]})}><Plus size={16}/>添加项目介绍</Button>}</section>
   <section className="person-edit-sharing"><h2>谁可以看到这份资料</h2><p className="person-muted">称呼、介绍、方向和项目共用此范围。经历与贡献仍按各自原有许可显示。</p><label><span className="sr-only">个人资料可见范围</span><select aria-label="个人资料可见范围" value={values.visibility} onChange={event=>change({visibility:event.target.value==='Public'?'Public':'Private'})}><option value="Private">自己和选择的人</option><option value="Public">公开</option></select></label>
    {values.visibility==='Private'&&<PeoplePicker runtime={runtime} client={client} subjectId={subjectId} value={values.viewers} onChange={viewers=>change({viewers})} disabled={disabled}/>}
    <label className="person-checkbox"><input type="checkbox" checked={values.expiresAt===null} onChange={event=>change({expiresAt:event.target.checked?null:Math.floor(Date.now()/1000)+30*86400})}/><span>持续展示<small>直到你修改这份资料的分享范围。</small></span></label>
    {values.expiresAt!==null&&<div className="person-edit-deadline"><label htmlFor={fieldId+'-until'}>可查看至<Input id={fieldId+'-until'} aria-label="资料可查看至" type="datetime-local" step={1} required value={localTime(values.expiresAt)} onChange={event=>{const time=Date.parse(event.target.value);if(Number.isFinite(time))change({expiresAt:Math.floor(time/1000)});}}/></label><p>到期后停止对外展示，原工作事实不会因此改变。</p></div>}
   </section>
  </fieldset><footer className="person-edit-actions"><Button type="submit" disabled={disabled||!!conflict||draftElsewhere||!!localConflict}>{busy?'正在保存…':'保存资料'}</Button><Button type="button" variant="ghost" disabled={busy||!draft.ready||!!pending} onClick={()=>void cancel()}>取消修改</Button><output aria-live="polite">{draft.status||(!draft.ready?'正在读取本机草稿…':'修改会自动保存在本机。')}</output></footer></form>
 </>;
}
