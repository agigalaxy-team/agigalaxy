import React,{useEffect,useEffectEvent,useId,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {TaskOperationRecovery} from './task-operation-recovery';
import {TaskPublishDraftComparison} from './task-publish-draft-recovery';
import {ordinaryPublicationFromDraft,taskWriteError,taskFieldPresent} from './task-bounty-client.mjs';
import {ArrowLeft,ArrowRight,BookOpen,Eye,Globe,Lock,Search} from 'lucide-react';
import {createTaskPreparationClient} from './task-preparation-client.mjs';
import {TaskPreparationWorkspace} from './task-preparation-workspace';
import {contactCandidates} from './task-contact-client.mjs';
import './task-help-continuation.css';
import {AccountVerificationPrompt,needsAccountVerification} from './account-verification-prompt';
import {createHelpOriginClient,helpOriginLocator,helpOriginPayload} from './help-origin-client.mjs';
import {TaskOriginPicker} from './task-origin-workspace';
import {TaskAgentIdentityPrompt} from './task-agent-identity-prompt';
import {createCommunityForumClient} from './community-forum-client.mjs';
import {forumTaskLocator,forumTaskMaterialSelection} from './community-forum-origin.mjs';
import {createTaskMaterialClient,draftMaterialIds,hasMaterialText,literalTaskText,localTaskTextView,replaceLiteralTaskText,removeMaterialTaskText,adoptPreparedTaskMaterials} from './task-material-client.mjs';
import {TaskForumMaterialWorkspace,TaskMaterialDraftField} from './task-forum-material-workspace';
import {availableForumContent,type ForumClient,type ForumPostView} from './community-forum-view-types';
import type {TaskText,TaskTextField,TaskMaterialBody,TaskMaterialStates,TaskMaterialInput,TaskMaterialOptions} from './task-material-types';
import {searchV2QuerySchema} from '../../galaxy-official/src/shared/search-v2-schema.mjs';
import {object} from './project-workspace-types';
import {readOperationReceipt} from './task-operation-state';
import type {OperationReceipt} from './task-operation-state';
import {readPublishDraft,taskEntryError} from './task-entry-types';
import type {TaskEntryRuntime,PublishDraft,TaskDraftHead,TaskPublication,HelpOriginSelection,HelpOriginView,HelpOriginClient,PreparationInput,PreparationChoice,PreparationSource,PreparationView,TaskEntryPreparationClient} from './task-entry-types';
import type {SearchReference} from './help-contact-view-types';


const preparationSubject=(value:unknown):value is string=>typeof value==='string'&&/^GUID[A-Z0-9]{28}$/.test(value);
const preparationSourceKey=(source:PreparationSource)=>JSON.stringify([source.search.type,source.ref.id,source.ref.version]);
function preparationSource(value:unknown):value is PreparationSource{return object(value)&&object(value.search)&&['history','opportunity'].includes(String(value.search.type))&&searchV2QuerySchema.safeParse(value.search).success&&object(value.ref)&&typeof value.ref.id==='string'&&typeof value.ref.version==='string';}
function preparationChoice(value:unknown):PreparationChoice{
 const raw=object(value)?value:{};
 const input=object(raw.input)&&typeof raw.input.keyword==='string'&&Array.isArray(raw.input.functions)&&raw.input.functions.every((item:unknown)=>typeof item==='string')&&typeof raw.input.capabilityId==='string'?{keyword:raw.input.keyword,functions:raw.input.functions.filter((item:unknown):item is string=>typeof item==='string'),capabilityId:raw.input.capabilityId}:null;
 const selected=Array.isArray(raw.selected)?[...new Set(raw.selected.filter(preparationSubject))]:[];
 const sources:PreparationChoice['sources']=Array.isArray(raw.sources)?raw.sources.flatMap((item:unknown)=>object(item)&&typeof item.subjectId==='string'&&selected.includes(item.subjectId)&&Array.isArray(item.sources)?[{subjectId:item.subjectId,sources:item.sources.filter(preparationSource).map(source=>({search:structuredClone(source.search),ref:structuredClone(source.ref)}))}]:[]):[];
 return{input,selected,sources,open:raw.open===true};
}
function selectedPreparation(value:PreparationView|null,selected:string[],previous:unknown):PreparationChoice{
 const before=preparationChoice(previous),sources=selected.map(subjectId=>{
  const retained=before.sources.find(item=>item.subjectId===subjectId),candidate=value?.candidates.find(item=>item.subjectId===subjectId);
  return retained??{subjectId,sources:(candidate?.sources??[]).map(source=>({search:structuredClone(source.search),ref:structuredClone(source.item.ref)}))};
 });
 return{...before,selected:[...selected],sources};
}
/** Restore only selected source locators; source bodies are read under the current identity. */
async function readPreparation(client:TaskEntryPreparationClient,runtime:TaskEntryRuntime,input:PreparationInput,choice:PreparationChoice,valid:()=>boolean):Promise<PreparationView|null>{
 const value=await client.query(input);if(!valid())return null;
 const pages=value.pages.map(page=>({...page,items:[...page.items]})),checked=new Set<string>();
 for(const selected of choice.sources){
  if(contactCandidates(pages,value.ownerId).some(candidate=>candidate.subjectId===selected.subjectId))continue;
  for(const source of selected.sources){
   const key=preparationSourceKey(source);if(checked.has(key))continue;checked.add(key);
   try{client.check();const current:SearchReference=await runtime.api.call('/v2/search/reference',source,{authenticated:true});client.check();if(!valid())return null;
    if(current.state!=='current'||current.item?.ref?.id!==source.ref.id||current.item.ref.version!==source.ref.version||current.item.type!==source.search.type)continue;
    pages.push({type:source.search.type,items:[current.item],search:source.search,nextCursor:null,error:null,retainedSelection:true});
   }catch{client.check();if(!valid())return null;}
   if(contactCandidates(pages,value.ownerId).some(candidate=>candidate.subjectId===selected.subjectId))break;
  }
 }
 const candidates=contactCandidates(pages,value.ownerId);
 return{...value,pages,candidates,selected:[...choice.selected],unavailable:choice.selected.filter(id=>!candidates.some(candidate=>candidate.subjectId===id)),retainedSelection:choice.sources};
}

type DraftFeedbackStage='read'|'save'|'read-input'|'gate';
type DraftFeedback={stage:DraftFeedbackStage;reason:unknown;blocked:boolean};
type DraftClient=ReturnType<TaskEntryRuntime['createTaskDraftClient']>;
type DraftSnapshot=Awaited<ReturnType<DraftClient['inspect']>>;
type DraftConflict={snapshot:DraftSnapshot;value:PublishDraft|null};
type RecoveryCopy={id:string;kind:'replaced'|'input';createdAt:number;snapshot:{head:TaskDraftHead|null;value:Record<string,unknown>}};
type BusinessFeedback={message:string;verificationRequired:boolean;code?:string};
type PublicationSelection={publication:TaskPublication;head:TaskDraftHead;revision:number;materialBodies:TaskMaterialBody[];origin:HelpOriginSelection|null};
function draftFeedbackTitle(feedback:DraftFeedback){
 if(feedback.stage==='read-input')return '读取期间又有新输入，尚未保存。';
 const known:Record<string,string>={task_draft_conflict:'本机稿已在另一页面更改或清空。',task_draft_record_invalid:'本机稿的格式、版本或编号无法核对。',task_draft_legacy_comparison_unavailable:'旧稿中的数据无法完整核对，尚未安全转换。',task_draft_id_unavailable:'暂时无法准备本机稿件编号。',task_draft_revision_limit:'本机稿的修订次数已到上限。',task_draft_value_invalid:'本机稿的编辑字段无法保存。',task_draft_reload_required:'需要重新核对当前已保存的本机稿。',task_draft_adapter_required:'当前环境尚不能安全更新本机稿。',local_atomic_update_unavailable:'当前环境尚不能安全更新本机稿。',task_draft_lease_invalid:'当前本机稿的身份范围无法核对。'};
 if(known[taskEntryError(feedback.reason,'code')||taskEntryError(feedback.reason)])return known[taskEntryError(feedback.reason,'code')||taskEntryError(feedback.reason)];
 if(feedback.stage==='gate')return '本机稿尚未核对。';
 if(taskEntryError(feedback.reason,'name')==='AbortError')return feedback.stage==='read'?'浏览器中止了这次本机稿读取。':'浏览器中止了这次本机稿保存。';
 if(taskEntryError(feedback.reason,'name')==='QuotaExceededError')return '浏览器暂时没有足够空间保存新输入。';
 if(taskEntryError(feedback.reason,'name')==='DataCloneError')return '本机稿中的部分数据无法复制。';
 return feedback.stage==='read'?'本机稿尚未读取完成。':'这次本机稿保存未完成。';
}

type Props={runtime:TaskEntryRuntime|null;subjectId?:string;connected:boolean;navigate:(path:string)=>void;onNeedIdentity?:()=>void;registerShellNavigation?:(scopeKey:string,handler:(path:string)=>void,leaveAction:(action:()=>void)=>void)=>()=>void};
export function TaskPublishWorkspace(props:Props){
 const scope=props.runtime?.taskDraftScope();
 if(!props.runtime||!scope||scope.closed||scope.subjectId!==(props.subjectId??null))return <section aria-busy="true"><h1 className="small">发起一个请求</h1><p>正在读取当前身份的本机稿。</p></section>;
 return <TaskPublishSession key={scope.key} sessionKey={scope.key} {...props} runtime={props.runtime}/>;
}
function TaskPublishSession({runtime,subjectId,connected,navigate,registerShellNavigation,sessionKey}:Props&{runtime:TaskEntryRuntime;sessionKey:string}){

 const draftClient=useMemo(()=>runtime.createTaskDraftClient(),[runtime]);
 const materialClient=useMemo(()=>createTaskMaterialClient(runtime,{subjectId:subjectId??null}),[runtime,subjectId]);
 const preparationClient:TaskEntryPreparationClient|null=useMemo(()=>runtime&&connected?createTaskPreparationClient(runtime):null,[runtime,connected]);
 const originClient:HelpOriginClient|null=useMemo(()=>runtime&&connected?createHelpOriginClient(runtime):null,[runtime,connected]);
 const originLocator=helpOriginLocator(location.pathname+location.search+location.hash);
 const forumLocator=useMemo(()=>forumTaskLocator(location.pathname+location.search+location.hash),[]);
 const forumClient:ForumClient|null=useMemo(()=>runtime&&forumLocator?createCommunityForumClient(runtime,{subjectId:subjectId??null}):null,[runtime,forumLocator,subjectId]);
 const [forumSourceState,setForumSourceState]=useState('reading'),[forumSource,setForumSource]=useState<ForumPostView|null>(null);
 const [selectMaterials,setSelectMaterials]=useState(()=>forumTaskMaterialSelection(location.pathname+location.search+location.hash));
 function selectForumMaterials(open:boolean){const url=new URL(location.href);if(open)url.searchParams.set('forumMaterial','select');else url.searchParams.delete('forumMaterial');history.replaceState(history.state,'',url.pathname+url.search+url.hash);setSelectMaterials(open);}
 const forumReadEpoch=useRef(0);
 async function refreshForumSource(){
  if(!forumClient||!forumLocator)return;const token=++forumReadEpoch.current;setForumSourceState('reading');
  try{const value=await forumClient.version(forumLocator.postId,forumLocator.versionId);if(token!==forumReadEpoch.current||!current()||document.hidden||!navigator.onLine)return;setForumSource(value);setForumSourceState(availableForumContent(value,Math.floor(Date.now()/1000))?'available':'unavailable');}
  catch{if(token===forumReadEpoch.current&&current())setForumSourceState('unknown');}
 }
 const readForumSource=useEffectEvent(()=>{if(!document.hidden&&!working.current)void refreshForumSource();});
 useEffect(()=>{
  const reads=forumReadEpoch;readForumSource();const hide=()=>{reads.current++;setForumSourceState('unknown');},visible=()=>{hide();if(!document.hidden&&navigator.onLine)readForumSource();};
  const timer=setInterval(()=>readForumSource(),15000);document.addEventListener('visibilitychange',visible);window.addEventListener('offline',hide);window.addEventListener('online',visible);
  return()=>{reads.current++;clearInterval(timer);document.removeEventListener('visibilitychange',visible);window.removeEventListener('offline',hide);window.removeEventListener('online',visible);forumClient?.close();};
 },[forumClient,forumLocator]);
 const [originPreview,setOriginPreview]=useState<HelpOriginSelection|null>(null),[originReview,setOriginReview]=useState<HelpOriginView|null>(null),[sourceRevision,setSourceRevision]=useState(0);
 const [preparation,setPreparation]=useState<PreparationView|null>(null),[searching,setSearching]=useState(false),[searchError,setSearchError]=useState('');
 const queryEpoch=useRef(0),confirmedQuery=useRef<PreparationInput|null>(null),queryWorking=useRef(false),preparationRef=useRef<PreparationView|null>(null);
 const [draft,setDraft]=useState(()=>readPublishDraft()),[loaded,setLoaded]=useState(false);
 const draftRef=useRef(draft),draftHead=useRef<TaskDraftHead|null>(null),draftSnapshot=useRef<Awaited<ReturnType<typeof draftClient.inspect>>>(null),inputRevision=useRef(0),draftReadEpoch=useRef(0),draftReading=useRef(true),draftReloadRequired=useRef(true);
 const [materialStates,setMaterialStates]=useState<TaskMaterialStates>({}),[materialClock,setMaterialClock]=useState(()=>Math.floor(Date.now()/1000)),[previewBodies,setPreviewBodies]=useState<TaskMaterialBody[]>([]);
 const materialReadEpoch=useRef(0);
 const [draftFeedback,setDraftFeedback]=useState<DraftFeedback|null>(null),[saveMessage,setSaveMessage]=useState(''),[readingDraft,setReadingDraft]=useState(true);
 const [draftConflict,setDraftConflict]=useState<DraftConflict|null>(null),[recoveryCopies,setRecoveryCopies]=useState<RecoveryCopy[]>([]),[selectedCopyId,setSelectedCopyId]=useState(''),[copiesOpen,setCopiesOpen]=useState(false),[copyReadError,setCopyReadError]=useState('');
 const [conflictMaterialStates,setConflictMaterialStates]=useState<TaskMaterialStates>({}),[copyMaterialStates,setCopyMaterialStates]=useState<TaskMaterialStates>({});
 const conflictReadEpoch=useRef(0),recoveryMaterialEpoch=useRef(0),copyReadEpoch=useRef(0),lastWritingFocus=useRef<HTMLElement|null>(null),focusAfterRecovery=useRef(false);
 const draftFeedbackRef=useRef<DraftFeedback|null>(null),draftErrorOrigins=useRef(new WeakMap<object,DraftFeedbackStage>()),savedInputRevision=useRef(0);
 const [preview,setPreview]=useState<TaskPublication|null>(null),[pending,setPending]=useState<unknown>(null),[busy,setBusy]=useState(false),[error,setErrorMessage]=useState(''),[notice,setNotice]=useState('');
 const [verificationRequired,setVerificationRequired]=useState(false);
 const businessFeedbackRef=useRef<BusinessFeedback>({message:'',verificationRequired:false});
 function localFailureStage(reason:unknown){return reason&&typeof reason==='object'?draftErrorOrigins.current.get(reason):undefined;}
 function markDraftFailure(reason:unknown,stage:DraftFeedbackStage){if(reason&&typeof reason==='object'&&!draftErrorOrigins.current.has(reason))draftErrorOrigins.current.set(reason,stage);return reason;}
 function showDraftFeedback(value:DraftFeedback|null){draftFeedbackRef.current=value;setDraftFeedback(value);}
 function showDraftFailure(stage:DraftFeedbackStage,reason:unknown,blocked=false){markDraftFailure(reason,stage);const prior=draftFeedbackRef.current;
  if(prior&&(stage==='gate'||taskEntryError(reason,'code')==='task_draft_reload_required')){showDraftFeedback({...prior,blocked:prior.blocked||blocked});return;}
  showDraftFeedback({stage,reason,blocked:blocked||!!(prior&&prior.reason===reason&&prior.blocked)});if(taskEntryError(reason,'code')==='task_draft_conflict'&&loaded)void readDraftConflict(reason);}
 function showBusinessFeedback(value:BusinessFeedback){businessFeedbackRef.current=value;setErrorMessage(value.message);setVerificationRequired(value.verificationRequired);}
 function setError(reason:unknown){const stage=localFailureStage(reason);if(stage){showDraftFailure(stage,reason,true);return;}showBusinessFeedback({message:typeof reason==='string'?reason:taskWriteError(reason),verificationRequired:needsAccountVerification(reason),code:taskEntryError(reason,'code')});}
 const [lastReceipt,setLastReceipt]=useState<OperationReceipt|null>(null),[backgroundOpen,setBackgroundOpen]=useState(false),[referenceSearchOpen,setReferenceSearchOpen]=useState(false),[agentReady,setAgentReady]=useState(false);
 const flowTop=useRef<HTMLElement>(null),lastFlowPhase=useRef<string|null>(null);
 const flowPhase=preview?'preview':'edit';
 useEffect(()=>{const phase=flowPhase;if(lastFlowPhase.current!==null&&phase!==lastFlowPhase.current)flowTop.current?.scrollIntoView({block:'start'});lastFlowPhase.current=phase;},[flowPhase]);
 const recoveringPublication=useRef(false);
 const epoch=useRef(0),working=useRef(false);
 const current=()=>{try{draftClient.check();return true;}catch{return false;}};
 useEffect(()=>{if(!busy&&focusAfterRecovery.current){focusAfterRecovery.current=false;if(lastWritingFocus.current?.isConnected)lastWritingFocus.current.focus({preventScroll:true});else flowTop.current?.querySelector<HTMLElement>('.request-writing-fields input,.request-writing-fields textarea')?.focus({preventScroll:true});}},[busy]);
 const navigationHandler=useRef<(destination:string|(()=>void))=>void>(()=>{});
 useLayoutEffect(()=>{navigationHandler.current=navigateWithSavedDraft;});
 useLayoutEffect(()=>loaded?registerShellNavigation?.(sessionKey,path=>navigationHandler.current(path),action=>navigationHandler.current(action)):undefined,[registerShellNavigation,sessionKey,loaded]);
 const loadInitialDraft=useEffectEvent(()=>readLocalDraft());
 const observePublication=useEffectEvent((token:number)=>Promise.all([runtime.getLocal('task-publication',draftClient.ownerKey),runtime.getLocal('task-publication-receipt',draftClient.ownerKey)]).then(([pending,receipt])=>{if(token===epoch.current&&current()){setPending(pending);setLastReceipt(receipt==null?null:readOperationReceipt(receipt));}}).catch((reason:unknown)=>{if(token===epoch.current&&current())setError(reason);}));
 const readPublication=useEffectEvent((token:number)=>{if(document.visibilityState!=='visible'||working.current||recoveringPublication.current||!current())return;recoveringPublication.current=true;void runtime.getLocal('task-publication',draftClient.ownerKey).then((pending:unknown)=>{if(token===epoch.current&&current())setPending(pending);}).catch((reason:unknown)=>{if(token===epoch.current&&current())setError(reason);}).finally(()=>{if(token===epoch.current)recoveringPublication.current=false;});});
 useEffect(()=>{const lifetime=epoch,token=++lifetime.current;
  void loadInitialDraft();void observePublication(token);
  const reload=()=>readPublication(token);reload();
  const timer=window.setInterval(reload,15000);document.addEventListener('visibilitychange',reload);
  return()=>{lifetime.current++;window.clearInterval(timer);document.removeEventListener('visibilitychange',reload);void draftClient.flush().catch(()=>{}).finally(()=>draftClient.close());};},[draftClient]);
 useEffect(()=>()=>{queryEpoch.current++;preparationClient?.close();},[preparationClient]);
 useEffect(()=>()=>originClient?.close(),[originClient]);
 useEffect(()=>()=>materialClient.close(),[materialClient]);
 async function refreshMaterials(){
  const original=structuredClone(draftRef.current),signature=JSON.stringify(original.materials),token=++materialReadEpoch.current;
  if(!original.materials.length){setMaterialStates({});return;}
  setMaterialStates(Object.fromEntries(original.materials.map(material=>[material.materialId,{status:'unavailable',reason:'checking',availableUntil:material.expiresAt}])));
  try{
   const result=await materialClient.sanitize(original);if(token!==materialReadEpoch.current||!current()||signature!==JSON.stringify(draftRef.current.materials)||document.hidden||!navigator.onLine)return;
   setMaterialStates(result.states);
   if(businessFeedbackRef.current.code==='task_material_unavailable'&&original.materials.every(material=>result.states[material.materialId]?.status==='available')){showBusinessFeedback({message:'',verificationRequired:false});setNotice('材料已重新核对，可以继续发布。');}
   if(result.erased.length&&!working.current&&!draftReading.current&&!draftReloadRequired.current){
    await flushDraft();if(token!==materialReadEpoch.current||!current()||signature!==JSON.stringify(draftRef.current.materials))return;
    const revision=inputRevision.current,expected=structuredClone(draftSnapshot.current),next=structuredClone(draftRef.current);
    next.materialBodies=next.materialBodies.filter(body=>!result.erased.includes(body.materialId));
    if(next.materialBodies.length===draftRef.current.materialBodies.length)return;
    const saved=await draftClient.compareAndSave(next,{expected,assertCurrent:()=>{draftClient.check();if(revision!==inputRevision.current||signature!==JSON.stringify(draftRef.current.materials))throw Object.assign(Error('清理期间原稿已变化。'),{code:'task_draft_input_changed'});}});
    if(token!==materialReadEpoch.current||!current()||revision!==inputRevision.current)return;
    draftSnapshot.current=saved;draftHead.current=saved.head;draftRef.current=readPublishDraft(saved.value);setDraft(draftRef.current);setPreview(null);setPreviewBodies([]);
    setNotice('来源已撤回或到期，对应材料文字已从本机稿清理；独立说明仍保留。');
   }
  }catch(reason:unknown){if(token===materialReadEpoch.current&&current()&&taskEntryError(reason,'code')==='task_draft_conflict'){draftReloadRequired.current=true;showDraftFailure('save',reason);}}
 }
 const materialSignature=JSON.stringify(draft.materials);
 const readMaterialSources=useEffectEvent(()=>{if(loaded&&!document.hidden&&navigator.onLine&&!working.current)void refreshMaterials();});
 const updateMaterialClock=useEffectEvent(()=>{const time=Math.floor(Date.now()/1000);setMaterialClock(time);if(forumSource?.payload&&(forumSource.publishedUntil??Infinity)<=time){setForumSource({...forumSource,payload:undefined,availability:'expired'});setForumSourceState('unavailable');}});
 useEffect(()=>{
  const reads=materialReadEpoch;readMaterialSources();const tick=setInterval(()=>updateMaterialClock(),1000);
  const hide=()=>{reads.current++;setMaterialStates({});},refresh=()=>{hide();readMaterialSources();},timer=setInterval(()=>readMaterialSources(),15000);
  document.addEventListener('visibilitychange',refresh);window.addEventListener('online',refresh);window.addEventListener('offline',hide);
  return()=>{reads.current++;clearInterval(tick);clearInterval(timer);document.removeEventListener('visibilitychange',refresh);window.removeEventListener('online',refresh);window.removeEventListener('offline',hide);};
 },[materialClient,materialSignature,loaded]);
 async function searchPreparation(input:PreparationInput|null=confirmedQuery.current,{background=false}={}){
  if(!input)return;const token=++queryEpoch.current,valid=()=>token===queryEpoch.current&&current();queryWorking.current=true;
  if(!background){setPreparation(null);preparationRef.current=null;setSearching(true);}setSearchError('');
  if(!preparationClient){queryWorking.current=false;setSearching(false);setSearchError('连接身份后可以查找已有的帮助，草稿仍可继续准备。');return;}
  try{const value=await readPreparation(preparationClient,runtime,input,preparationChoice(draftRef.current.helpPreparation),valid);if(!value||!valid())return;
   const selected=preparationChoice(draftRef.current.helpPreparation).selected,next={...value,selected};setPreparation(next);preparationRef.current=next;
  }catch{if(valid()){setPreparation(null);preparationRef.current=null;setSearchError('相关帮助暂时无法读取。已记下的人仍保留，这份求助可以继续发布。');}}
  finally{if(valid()){queryWorking.current=false;setSearching(false);}}
 }
 const readRelated=useEffectEvent(()=>{if(document.hidden||working.current||queryWorking.current||!confirmedQuery.current||!current())return;void searchPreparation(confirmedQuery.current,{background:true});});
 useEffect(()=>{const read=()=>readRelated();const timer=setInterval(read,20000);document.addEventListener('visibilitychange',read);return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',read);};},[preparationClient]);
 function rememberPreparation(selected:string[]){const choice=selectedPreparation(preparationRef.current,selected,draftRef.current.helpPreparation);change('helpPreparation',choice);if(preparationRef.current){const next={...preparationRef.current,selected};setPreparation(next);preparationRef.current=next;}}
 function toggleRelated(){const open=!referenceSearchOpen;setReferenceSearchOpen(open);change('helpPreparation',{...preparationChoice(draftRef.current.helpPreparation),open});}
 function independentKeyword(value:PublishDraft){return typeof value.searchKeyword==='string'?value.searchKeyword:value.searchKeyword===undefined&&!hasMaterialText(value.title)?literalTaskText(value.title):'';}
 function findRelated(){const input={keyword:independentKeyword(draftRef.current).trim(),functions:(draftRef.current.searchFunctions??'').split(/[,，\n]/).map((value:string)=>value.trim()).filter(Boolean),capabilityId:draftRef.current.capabilityId.trim()};confirmedQuery.current=input;change('helpPreparation',{...preparationChoice(draftRef.current.helpPreparation),input,open:true});void searchPreparation(input);}
 async function readLocalDraft(){const token=epoch.current,ticket=++draftReadEpoch.current,revision=inputRevision.current;draftReading.current=true;draftReloadRequired.current=true;
  try{const value=await(selectMaterials?draftClient.inspect():draftClient.load());if(token!==epoch.current||!current()||ticket!==draftReadEpoch.current)return;
   if(revision!==inputRevision.current){showDraftFailure('read-input',null);setSaveMessage('本页新输入尚未保存。');return;}
   const next=readPublishDraft(value?.value??{});draftRef.current=next;draftSnapshot.current=value;draftHead.current=value?.head??null;savedInputRevision.current=revision;setDraft(next);setBackgroundOpen([next.goal,next.situation,next.expectedOutcome].some(taskFieldPresent));setMaterialStates({});setPreview(null);setOriginPreview(null);setOriginReview(null);setLoaded(true);draftReloadRequired.current=false;showDraftFeedback(null);setDraftConflict(null);setSaveMessage(value?'本机稿已读取。':'输入后会自动保存到此浏览器。');queryEpoch.current++;queryWorking.current=false;setPreparation(null);preparationRef.current=null;setSearching(false);setSearchError('');const preparation=preparationChoice(next.helpPreparation);setReferenceSearchOpen(preparation.open);confirmedQuery.current=preparation.input;if(preparation.input)void searchPreparation(preparation.input);void readRecoveryCopies();
  }catch(reason:unknown){if(token===epoch.current&&current()&&ticket===draftReadEpoch.current){showDraftFailure('read',reason);setSaveMessage('尚未读取本机版本。');}}
  finally{if(token===epoch.current&&current()&&ticket===draftReadEpoch.current){draftReading.current=false;setReadingDraft(false);}}}
 async function readRecoveryCopies(){const token=epoch.current,ticket=++copyReadEpoch.current;
  try{const values=await draftClient.readRecoveryCopies();if(token!==epoch.current||!current()||ticket!==copyReadEpoch.current)return;
   setRecoveryCopies([...values].sort((left,right)=>right.createdAt-left.createdAt));setSelectedCopyId(previous=>values.some(value=>value.id===previous)?previous:values.at(-1)?.id??'');setCopyReadError('');
  }catch{if(token===epoch.current&&current()&&ticket===copyReadEpoch.current)setCopyReadError('保留的另一份输入暂时无法读取，当前编辑内容仍保留。');}
 }
 async function readDraftConflict(reason?:unknown){const token=epoch.current,ticket=++conflictReadEpoch.current;setReadingDraft(true);setConflictMaterialStates({});
  try{const raw=object(reason)&&Object.hasOwn(reason,'current')?reason.current:await draftClient.inspect();if(token!==epoch.current||!current()||ticket!==conflictReadEpoch.current)return;
   if(raw!==null&&(!object(raw)||!object(raw.value)||raw.head!==null&&(!object(raw.head)||typeof raw.head.id!=='string'||typeof raw.head.revision!=='number')))throw Object.assign(Error('另一份草稿暂时无法完整核对，本页输入仍保留。'),{code:'task_draft_record_invalid'});
   const snapshot=raw as DraftSnapshot;setDraftConflict({snapshot:structuredClone(snapshot),value:snapshot?readPublishDraft(snapshot.value):null});
  }catch(failure){if(token===epoch.current&&current()&&ticket===conflictReadEpoch.current)showDraftFailure('read',failure);}
  finally{if(token===epoch.current&&current()&&ticket===conflictReadEpoch.current)setReadingDraft(false);}
 }
 async function recoverDraft(valid:()=>boolean,choice:'current'|'saved'|'copy'='current'){
  const revision=inputRevision.current,original=structuredClone(draftRef.current),shown=draftConflict,copy=recoveryCopies.find(value=>value.id===selectedCopyId);
  const candidate=choice==='saved'?readPublishDraft(shown?.snapshot?.value??{}):choice==='copy'&&copy?readPublishDraft(copy.snapshot.value):original;
  if(choice==='saved'&&!shown||choice==='copy'&&!copy)throw Error('请先核对要继续的输入。');
  const expected=structuredClone(shown&&choice!=='copy'?shown.snapshot:draftSnapshot.current);
  const preserveReplaced=!!(shown&&choice==='current'||choice==='copy'),preserveInput=choice==='saved'||choice==='copy'&&revision!==savedInputRevision.current;
  const guard=()=>{draftClient.check();if(!valid()||revision!==inputRevision.current)throw Object.assign(Error('保存期间本页输入已变化，文字仍保留。'),{code:'task_draft_input_changed'});};
  guard();draftReadEpoch.current++;conflictReadEpoch.current++;setReadingDraft(false);setMaterialStates({});setPreview(null);setPreviewBodies([]);setOriginPreview(null);setOriginReview(null);
  try{
   type CheckedDraft={value:PublishDraft;states:TaskMaterialStates;erased:Set<string>};
   const checkMaterials=async(value:PublishDraft):Promise<CheckedDraft>=>{guard();if(!value.materials.length)return{value,states:{},erased:new Set()};const checked=await materialClient.sanitize(value);guard();return{value:readPublishDraft(checked.value),states:checked.states,erased:new Set(checked.erased)};};
   const selected=await checkMaterials(candidate),input=preserveInput?await checkMaterials(original):null,replaced=preserveReplaced&&expected?await checkMaterials(readPublishDraft(expected.value)):null;
   const checked=[selected,input,replaced].filter((value):value is CheckedDraft=>value!==null);
   const deadline=(value:CheckedDraft,id:string,until:number)=>Math.min(until,value.states[id]?.availableUntil??until);
   const pruneExpired=()=>{const now=Math.floor(Date.now()/1000);for(const value of checked){for(const material of value.value.materials)if(deadline(value,material.materialId,material.expiresAt)<=now)value.erased.add(material.materialId);value.value={...value.value,materialBodies:value.value.materialBodies.filter(body=>!value.erased.has(body.materialId))};}};
   const assertSafe=()=>{guard();materialClient.check();const now=Math.floor(Date.now()/1000);if(checked.some(value=>value.value.materials.some(material=>value.value.materialBodies.some(body=>body.materialId===material.materialId)&&deadline(value,material.materialId,material.expiresAt)<=now)))throw Object.assign(Error('材料在保存前已到期，正在保留独立文字。'),{code:'task_material_recovery_expired'});};
   let saved:Awaited<ReturnType<DraftClient['recover']>>;
   for(;;){pruneExpired();try{saved=await draftClient.recover(selected.value,{expected,assertCurrent:assertSafe,...(preserveReplaced?{preserveReplaced:true,eraseReplacedMaterialIds:[...(replaced?.erased??[])]}:{}),...(input?{preserveInput:input.value}:{})});break;}catch(reason){if(taskEntryError(reason,'code')!=='task_material_recovery_expired')throw reason;guard();}}
   guard();
   const next=readPublishDraft(saved.value),adoptedRevision=++inputRevision.current;draftRef.current=next;draftSnapshot.current=saved;draftHead.current=saved.head;savedInputRevision.current=adoptedRevision;draftReloadRequired.current=false;setDraft(next);setDraftConflict(null);showDraftFeedback(null);setSaveMessage('当前输入已保存到此浏览器。');setSourceRevision(value=>value+1);focusAfterRecovery.current=true;
   if(choice!=='current'){setBackgroundOpen([next.goal,next.situation,next.expectedOutcome].some(taskFieldPresent));queryEpoch.current++;queryWorking.current=false;setPreparation(null);preparationRef.current=null;setSearching(false);setSearchError('');const preparation=preparationChoice(next.helpPreparation);setReferenceSearchOpen(preparation.open);confirmedQuery.current=preparation.input;if(preparation.input)void searchPreparation(preparation.input);}
   void readRecoveryCopies();void refreshMaterials();
  }catch(reason){draftReloadRequired.current=true;throw markDraftFailure(reason,'save');}
 }
 async function flushDraft(){if(draftReading.current||draftReloadRequired.current)throw markDraftFailure(Error('本页输入尚未安全保存，请先处理本机稿提示。'),'gate');try{await draftClient.flush();}catch(reason){throw markDraftFailure(reason,'save');}}
 async function run(fn:(valid:()=>boolean)=>Promise<void>){if(working.current)return;const token=epoch.current,valid=()=>token===epoch.current&&current(),previousBusinessFeedback=businessFeedbackRef.current;working.current=true;setBusy(true);setError('');setNotice('');try{await fn(valid);}catch(e){if(valid()){if(localFailureStage(e)&&!businessFeedbackRef.current.message&&previousBusinessFeedback.message)showBusinessFeedback(previousBusinessFeedback);setError(e);}}finally{if(valid()){try{const p=await runtime.getLocal('task-publication',draftClient.ownerKey);if(valid())setPending(p);}catch{}if(valid()){working.current=false;setBusy(false);}}}}
 function navigateWithSavedDraft(destination:string|(()=>void)){void run(async valid=>{await flushDraft();if(valid()){if(typeof destination==='string')navigate(destination);else destination();}});}
 function saveInput(next:PublishDraft){if(working.current)return;const revision=++inputRevision.current,ticket=draftReadEpoch.current,token=epoch.current;draftRef.current=next;setDraft(next);setPreview(null);setPreviewBodies([]);setOriginPreview(null);setOriginReview(null);
  if(draftReading.current||draftReloadRequired.current){setSaveMessage('本页新输入尚未保存。');return;}
  setSaveMessage('正在保存到此浏览器…');void draftClient.save(next).then(saved=>{if(token!==epoch.current||!current()||ticket!==draftReadEpoch.current)return;draftSnapshot.current=saved;draftHead.current=saved.head;if(revision===inputRevision.current){savedInputRevision.current=revision;setSaveMessage('已保存到此浏览器。');showDraftFeedback(null);}}).catch((reason:unknown)=>{if(token===epoch.current&&current()&&ticket===draftReadEpoch.current){draftReloadRequired.current=true;showDraftFailure('save',reason);setSaveMessage('本页新输入尚未保存，仍保留在编辑框中。');}});}

 function change<K extends keyof PublishDraft>(field:K,value:PublishDraft[K]){const original=draftRef.current[field];saveInput(readPublishDraft({...draftRef.current,[field]:typeof value==='string'&&hasMaterialText(original)?replaceLiteralTaskText(original,value):value}));}
 function editMaterial(materialId:string,text:string){saveInput({...draftRef.current,materialBodies:draftRef.current.materialBodies.map(body=>body.materialId===materialId?{...body,text}:body)});}
 function removeMaterial(field:TaskTextField,materialId:string){saveInput({...draftRef.current,[field]:removeMaterialTaskText(draftRef.current[field],materialId)});}
 function restoreMaterial(field:TaskTextField){const next=structuredClone(draftRef.current);if(!Object.hasOwn(next.materialRestore,field))return;next[field]=next.materialRestore[field];delete next.materialRestore[field];saveInput(next);void refreshMaterials();}

 async function finish(receipt:OperationReceipt){const id=receipt.taskId??receipt.result?.taskId;if(!id)return;const token=epoch.current,revision=inputRevision.current;let unsaved=draftReading.current||draftReloadRequired.current;try{await draftClient.flush();}catch{unsaved=true;}if(token!==epoch.current||!current())return;unsaved=unsaved||revision!==inputRevision.current;setPreview(null);
  if(unsaved||receipt.localDraftCleanup?.state==='failed'){setLastReceipt({taskId:id});setNotice(unsaved?'求助已经发布，后来输入的内容仍保留在这里。':'求助已经发布。本机草稿暂未清理，原内容仍保留；可以直接打开上次发布的求助。');return;}navigate(`/app/tasks/${id}`);}
 async function reviewOrigin(selection:HelpOriginSelection|null,valid:()=>boolean){if(!selection)return null;if(!originClient)throw Error('请先连接原身份，再核对所选原工作。');try{const value=await originClient.validate(selection);return valid()?value:null;}catch(error){if(valid()){setOriginReview(null);setOriginPreview(null);setPreview(null);setSourceRevision(value=>value+1);}throw error;}}
 function assertDraftRevision(revision:number,valid:()=>boolean,selection:()=>void=()=>{}){draftClient.check();materialClient.check();selection();if(!valid()||revision!==inputRevision.current)throw Object.assign(Error('核对期间本页输入已变化，原稿仍保留。'),{code:'task_draft_input_changed'});}
 const sameHead=(left:TaskDraftHead|null,right:TaskDraftHead|null)=>!!left&&!!right&&left.id===right.id&&left.revision===right.revision;
 async function savePreparedDraft(candidate:PublishDraft,expected:Awaited<ReturnType<typeof draftClient.inspect>>,revision:number,valid:()=>boolean,selection:()=>void=()=>{}){
  const activeIds=new Set<string>(draftMaterialIds(candidate)),activeMaterials=candidate.materials.filter(material=>activeIds.has(material.materialId));
  const guard=()=>{assertDraftRevision(revision,valid,selection);if(activeMaterials.some(material=>material.expiresAt<=Math.floor(Date.now()/1000)))throw Object.assign(Error('选定材料已到期，原稿仍保留。'),{code:'task_material_expired'});};
  guard();let saved;
  try{saved=await draftClient.compareAndSave(candidate,{expected,assertCurrent:guard});}catch(reason){draftReloadRequired.current=true;throw markDraftFailure(reason,'save');}
  if(!valid()||revision!==inputRevision.current)return null;
  const adoptedRevision=++inputRevision.current;draftSnapshot.current=saved;draftHead.current=saved.head;draftRef.current=readPublishDraft(saved.value);savedInputRevision.current=adoptedRevision;setDraft(draftRef.current);showDraftFeedback(null);setSaveMessage('已保存到此浏览器。');
  setMaterialStates(Object.fromEntries(activeMaterials.map(material=>[material.materialId,{status:'available',availableUntil:material.expiresAt,checkedAt:Math.floor(Date.now()/1000)}])));
  return{head:saved.head,revision:adoptedRevision};
 }
 async function adoptMaterials(input:TaskMaterialInput,options:TaskMaterialOptions,selection:()=>void,valid:()=>boolean){
  const revision=inputRevision.current;await flushDraft();assertDraftRevision(revision,valid,selection);const expected=structuredClone(draftSnapshot.current),original=structuredClone(draftRef.current);
  const prepared=await materialClient.prepare(input);assertDraftRevision(revision,valid,selection);
  const candidate=readPublishDraft(adoptPreparedTaskMaterials(original,prepared,options)),ready=await materialClient.prepareDraft(candidate);assertDraftRevision(revision,valid,selection);
  const saved=await savePreparedDraft(readPublishDraft(ready.draft),expected,revision,valid,selection);if(!saved)return;
  setPreview(null);setPreviewBodies([]);setOriginPreview(null);setOriginReview(null);selectForumMaterials(false);setNotice('所选文字已带入草稿，可以继续编辑后发布。');
 }
 async function preparePublication(valid:()=>boolean):Promise<(PublicationSelection&{reviewed:HelpOriginView|null})|null>{
  const revision=inputRevision.current;await flushDraft();assertDraftRevision(revision,valid);
  const expected=structuredClone(draftSnapshot.current),prepared=await materialClient.prepareDraft(structuredClone(draftRef.current));assertDraftRevision(revision,valid);
  const candidate=readPublishDraft(prepared.draft),origin=candidate.helpOrigin?structuredClone(candidate.helpOrigin):null,reviewed=await reviewOrigin(origin,valid);assertDraftRevision(revision,valid);
  const publication=ordinaryPublicationFromDraft(candidate),saved=await savePreparedDraft(candidate,expected,revision,valid);if(!saved)return null;
  return{publication,...saved,materialBodies:prepared.materialBodies,origin,reviewed};
 }
 async function preparePreview(valid:()=>boolean){const selected=await preparePublication(valid);if(!selected||!valid())return;setPreviewBodies(selected.materialBodies);setOriginPreview(selected.origin);setOriginReview(selected.reviewed);setPreview(selected.publication);}
 async function submit(valid:()=>boolean){
  if(!preparationClient)throw Error('请先连接当前身份。');
  const selected=await preparePublication(valid);if(!selected||!valid())return;
  const selectedPreview=selected.publication,selectedHead=selected.head,revision=selected.revision,selectedBodies=selected.materialBodies,selectedOrigin=selected.origin;
  const guard=()=>{assertDraftRevision(revision,valid);if(!sameHead(selectedHead,draftHead.current))throw Object.assign(Error('原稿已变化，请核对当前内容。'),{code:'task_draft_conflict'});};
  await flushDraft();guard();const observed=await draftClient.inspect();guard();
  if(!sameHead(observed?.head??null,selectedHead)){draftReloadRequired.current=true;throw markDraftFailure(Object.assign(Error('另一页面已改变原稿，请重新核对后发布。'),{code:'task_draft_conflict'}),'gate');}
  if(selectedOrigin){const current=await reviewOrigin(selectedOrigin,valid);guard();const refs=helpOriginPayload(selectedOrigin);if(selectedPreview.caseId!==refs.caseId||selectedPreview.parentTaskId!==refs.parentTaskId||JSON.stringify(selectedPreview.workContext.attemptRefs)!==JSON.stringify(refs.attemptRefs))throw Error('原工作引用与当前求助不一致，请核对所选来源。');setOriginReview(current);}
  const choice=preparationChoice(draftRef.current.helpPreparation),prepared=choice.input&&choice.selected.length?await readPreparation(preparationClient,runtime,choice.input,choice,valid):preparationRef.current;guard();
  await preparationClient.freeze(selectedPreview,prepared,selectedOrigin?{taskId:selectedOrigin.taskId,returnTo:selectedOrigin.returnTo??'/app/tasks/'+selectedOrigin.taskId+'?section=collaboration'}:null);guard();
  const receipt=readOperationReceipt(await runtime.publishTask(selectedPreview,{confirmed:true,forumOrigin:forumLocator,draftHead:selectedHead,materialBodies:selectedBodies,assertCurrent:guard}));if(valid())await finish(receipt);
 }
 const fieldId=useId();
 const fieldMaterial=(field:TaskTextField,label:string)=><TaskMaterialDraftField {...{field,label,draft,busy}} value={draft[field]} states={materialStates} clock={materialClock} onEdit={editMaterial} onRemove={removeMaterial} onRestore={restoreMaterial} navigate={navigateWithSavedDraft}/>;
 const previewText=(value:TaskText|undefined)=>localTaskTextView(value,previewBodies,materialStates,materialClock);
 const previewBlocked=!!preview&&[preview.title,preview.summary,preview.workContext.goal,preview.workContext.currentSituation,preview.expectedOutcome].filter(value=>value!==undefined).some(value=>previewText(value).state!=='available');
 const displayPreview=(value:TaskText|undefined,title=false)=>{const view=previewText(value);return view.text||(view.state!=='available'?(title?'来源标题当前不可用':'对应来源材料当前不可用'):'');};
 const forumAvailable=forumSourceState==='available'&&availableForumContent(forumSource,materialClock)&&forumSource.authorId===subjectId;
 const visibilityOptions=[['Public','公开求助','其他人可以发现、阅读并回应',Globe],['Private','仅自己','先保留为自己的工作',Lock]] as const;
 const hasUnsavedInput=loaded&&inputRevision.current!==savedInputRevision.current;
 const selectedCopy=recoveryCopies.find(value=>value.id===selectedCopyId);
 const selectedCopyDraft=useMemo(()=>{try{return selectedCopy?readPublishDraft(selectedCopy.snapshot.value):null;}catch{return null;}},[selectedCopy]);
 const conflictSourceSignature=JSON.stringify(draftConflict?.value?.materials??[]),copySourceSignature=JSON.stringify(selectedCopyDraft?.materials??[]);
 const readRecoveryMaterialSources=useEffectEvent(()=>{const token=++recoveryMaterialEpoch.current,valid=()=>token===recoveryMaterialEpoch.current&&current()&&!document.hidden&&navigator.onLine;
  if(!valid())return;
  const read=async(value:PublishDraft|null,apply:(states:TaskMaterialStates)=>void)=>{if(!value?.materials.length){if(valid())apply({});return;}try{const checked=await materialClient.sanitize(value);if(valid())apply(checked.states);}catch{if(valid())apply({});}};
  void read(draftConflict?.value??null,setConflictMaterialStates);if(copiesOpen)void read(selectedCopyDraft,setCopyMaterialStates);
 });
 useEffect(()=>{const reads=recoveryMaterialEpoch,hide=()=>{reads.current++;setConflictMaterialStates({});setCopyMaterialStates({});},refresh=()=>{hide();readRecoveryMaterialSources();};refresh();const timer=setInterval(refresh,15000);window.addEventListener('offline',hide);window.addEventListener('online',refresh);document.addEventListener('visibilitychange',refresh);
  return()=>{reads.current++;clearInterval(timer);window.removeEventListener('offline',hide);window.removeEventListener('online',refresh);document.removeEventListener('visibilitychange',refresh);};
 },[materialClient,draftConflict,conflictSourceSignature,copySourceSignature,selectedCopyId,copiesOpen]);
 function recoveryCopyLabel(copy:RecoveryCopy){let title='';try{title=literalTaskText(readPublishDraft(copy.snapshot.value).title).trim();}catch{}const time=new Date(copy.createdAt);return[copy.kind==='input'?'切换前的本页输入':'切换前已保存的输入',Number.isFinite(time.getTime())?time.toLocaleString('zh-CN',{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'',title.slice(0,40)].filter(Boolean).join(' · ');}
 const draftDiagnostic=draftFeedback?.reason,diagnosticText=taskEntryError(draftDiagnostic)?taskEntryError(draftDiagnostic):typeof draftDiagnostic==='string'?draftDiagnostic:'',diagnosticCode=[taskEntryError(draftDiagnostic,'code'),taskEntryError(draftDiagnostic,'name')].filter(Boolean).join(' · ');
 return <section ref={flowTop} className="request-compose-page" aria-busy={busy}>
  <header className="request-compose-heading"><div><p className="eyebrow">一起推进一件事</p><h1 className="small">发起求助</h1></div>{!pending&&lastReceipt&&<a href={`/app/tasks/${lastReceipt.taskId}`} onClick={event=>{event.preventDefault();navigateWithSavedDraft(`/app/tasks/${lastReceipt.taskId}`);}}>上次发布 <ArrowRight size={14}/></a>}</header>
  {forumLocator&&<div className="request-origin"><BookOpen size={17}/><a href={forumLocator.returnTo} onClick={event=>{event.preventDefault();navigateWithSavedDraft(forumLocator.returnTo);}}>来自一段社区讨论</a>{forumSourceState==='unavailable'&&<span>原帖暂不可读</span>}{forumAvailable&&!selectMaterials&&<button className="text-action" type="button" disabled={busy||!!pending} onClick={()=>{setPreview(null);selectForumMaterials(true);}}>从这版选择我的材料</button>}</div>}
  {error&&<div className="message error" role="alert">{error}{businessFeedbackRef.current.code==='task_material_unavailable'&&<Button type="button" variant="outline" disabled={busy} onClick={()=>void refreshMaterials()}>重新核对材料</Button>}<AccountVerificationPrompt required={verificationRequired} navigate={navigateWithSavedDraft}/></div>}{notice&&<output className="message">{notice}</output>}
  {draftFeedback&&<section className="request-draft-recovery" aria-label="本机草稿恢复"><div role="alert" aria-label="本机稿提示"><h2>{draftConflict?'另一页更改了这份草稿':draftFeedbackTitle(draftFeedback)}</h2><p>{hasUnsavedInput&&'本页文字仍在编辑框中。'}{draftConflict?'核对后选用一份继续，另一份会保留在此浏览器。':loaded?'重新保存会先核对已有草稿，并保留你正在写的内容。':'重新读取草稿后即可继续。'}</p></div>
   {draftConflict&&<TaskPublishDraftComparison current={draft} other={draftConflict.value} currentStates={materialStates} otherStates={conflictMaterialStates} clock={materialClock}/>}
   <div className="button-row">{draftConflict&&<><Button type="button" disabled={busy||readingDraft||!!pending} onClick={()=>void run(valid=>recoverDraft(valid,'current'))}>继续本页内容</Button><Button type="button" variant="outline" disabled={busy||readingDraft||!!pending} onClick={()=>void run(valid=>recoverDraft(valid,'saved'))}>采用已保存内容</Button></>}
    <Button type="button" variant={draftConflict?'ghost':'default'} disabled={busy||readingDraft||!!pending} onClick={()=>{if(!loaded){setReadingDraft(true);showDraftFeedback(null);void readLocalDraft();}else if(draftConflict)void run(()=>readDraftConflict());else void run(valid=>recoverDraft(valid));}}>{readingDraft?'正在读取…':draftConflict?'重新核对已保存输入':loaded?'重新保存当前输入':'重新读取草稿'}</Button></div>
   {(diagnosticCode||diagnosticText)&&<details><summary>错误详情</summary><p style={{overflowWrap:'anywhere'}}>{diagnosticCode}{diagnosticCode&&diagnosticText?'：':''}{diagnosticText}</p></details>}
  </section>}
  {loaded&&(recoveryCopies.length>0||copyReadError)&&<details className="request-draft-copies" open={copiesOpen} onToggle={event=>setCopiesOpen(event.currentTarget.open)}><summary>查看保留的其他输入</summary><div>
   {copyReadError&&<output>{copyReadError} <Button type="button" variant="ghost" disabled={busy} onClick={()=>void readRecoveryCopies()}>重新读取</Button></output>}
   {recoveryCopies.length>1?<label htmlFor={fieldId+'-recovery-copy'}>保留的输入<select id={fieldId+'-recovery-copy'} value={selectedCopyId} onChange={event=>setSelectedCopyId(event.target.value)}>{recoveryCopies.map(copy=><option key={copy.id} value={copy.id}>{recoveryCopyLabel(copy)}</option>)}</select></label>:selectedCopy&&<p>{recoveryCopyLabel(selectedCopy)}</p>}
   {selectedCopyDraft?<><TaskPublishDraftComparison current={draft} other={selectedCopyDraft} currentStates={materialStates} otherStates={copyMaterialStates} clock={materialClock} currentLabel="正在编辑的内容" otherLabel="保留的输入" showAll/><Button type="button" variant="outline" disabled={busy||!!pending||!!draftConflict} onClick={()=>void run(valid=>recoverDraft(valid,'copy'))}>用这份继续编辑</Button><p>切换前会保留现在的输入。</p></>:selectedCopy&&<p>这份输入的部分内容暂时无法核对，原副本仍保留。</p>}
  </div></details>}
  <TaskOperationRecovery runtime={runtime} connected={connected} onComplete={finish} onStopped={()=>{setPending(null);setPreview(null);setNotice('已停止本机重试，草稿仍保留。');}}/>
  {loaded&&selectMaterials&&forumSource&&<TaskForumMaterialWorkspace key={forumSource.locator.versionId} source={forumSource} sourceState={forumAvailable?'available':forumSourceState==='reading'?'reading':'unavailable'} draft={draft} states={materialStates} busy={busy} onAdopt={(input,options,selection)=>void run(valid=>adoptMaterials(input,options,selection,valid))} onCancel={()=>selectForumMaterials(false)} onRefresh={()=>void refreshForumSource()}/>}
  {loaded&&selectMaterials&&!forumSource&&<div className="message"><output>正在读取所选准确版本。</output><Button variant="ghost" disabled={busy} onClick={()=>selectForumMaterials(false)}>先继续自己的求助</Button></div>}
  {loaded&&!selectMaterials&&<>
  {!preview&&<form className="request-compose-form request-continuous-form" onFocusCapture={event=>{const target=event.target;if(target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement)lastWritingFocus.current=target;}} onSubmit={event=>{event.preventDefault();if(connected&&agentReady)void run(submit);}}>
   <fieldset disabled={busy||!!pending} className="request-writing-fields">
    {!hasMaterialText(draft.title)&&<label htmlFor={fieldId+'-title'}>想做什么？<Input id={fieldId+'-title'} required maxLength={120} value={literalTaskText(draft.title)} onChange={event=>change('title',event.target.value)} placeholder="用一句话说说你的目标"/></label>}{fieldMaterial('title','标题')}
    <label htmlFor={fieldId+'-summary'}>需要怎样的帮助？<Textarea aria-label="需要怎样的帮助？" id={fieldId+'-summary'} required={!hasMaterialText(draft.summary)} maxLength={10000} value={literalTaskText(draft.summary)} onChange={event=>change('summary',event.target.value)} placeholder="现在在做什么、遇到什么问题，或想一起尝试什么？"/></label>{fieldMaterial('summary','说明')}
    <button className="text-action" type="button" aria-expanded={backgroundOpen} aria-controls={fieldId+'-background'} onClick={()=>setBackgroundOpen(value=>!value)}>{backgroundOpen?'收起补充内容':'补充背景或期待的结果'}</button>
    {backgroundOpen&&<div id={fieldId+'-background'} className="request-extra-fields">
     {taskFieldPresent(draft.goal)&&<><label htmlFor={fieldId+'-goal'}>具体目标<Textarea aria-label="具体目标" id={fieldId+'-goal'} maxLength={10000} value={literalTaskText(draft.goal)} onChange={event=>change('goal',event.target.value)}/></label>{fieldMaterial('goal','目标')}</>}
     <label htmlFor={fieldId+'-situation'}>背景资料 <small>可选</small><Textarea aria-label="背景资料" id={fieldId+'-situation'} maxLength={10000} value={literalTaskText(draft.situation)} onChange={event=>change('situation',event.target.value)} placeholder="理解这件事需要的环境、已有尝试或其他背景"/></label>{fieldMaterial('situation','背景')}
     <label htmlFor={fieldId+'-expectedOutcome'}>期待的结果 <small>可选</small><Textarea aria-label="期待的结果" id={fieldId+'-expectedOutcome'} maxLength={1500} value={literalTaskText(draft.expectedOutcome)} onChange={event=>change('expectedOutcome',event.target.value)} placeholder="例如一份建议、可以运行的修改或一次复核"/></label>{fieldMaterial('expectedOutcome','期待的结果')}
    </div>}
    <TaskOriginPicker {...{runtime,connected,busy,sourceRevision}} navigate={navigateWithSavedDraft} locator={originLocator} selection={draft.helpOrigin??null} onChange={(value:HelpOriginSelection|null)=>change('helpOrigin',value)}/>
   </fieldset>
   <fieldset disabled={busy||!!pending} className="request-share-fields"><legend>分享范围</legend>
    <div className="request-visibility">{visibilityOptions.map(([value,title,description,Icon])=><label htmlFor={fieldId+value} className={draft.visibility===value?'selected':''} key={value}><input id={fieldId+value} type="radio" name="request-visibility" checked={draft.visibility===value} onChange={()=>change('visibility',value)}/><Icon size={20}/><span><strong>{title}</strong><small>{description}</small></span><span className="choice-indicator"/></label>)}</div>
    <label className="request-enrollment" htmlFor={fieldId+'-enrollment'}><span>接受新回应直到<small>已有交流可以继续</small></span><Input id={fieldId+'-enrollment'} required type="datetime-local" value={draft.enrollmentLocal} onChange={event=>change('enrollmentLocal',event.target.value)}/></label>
   </fieldset>
   <section className="request-related request-related-help"><button type="button" className="text-action" disabled={busy} aria-expanded={referenceSearchOpen} onClick={toggleRelated}><Search size={16}/>看看已有的相关帮助{preparationChoice(draft.helpPreparation).selected.length?' · 已记下 '+preparationChoice(draft.helpPreparation).selected.length+' 位':''}</button>{referenceSearchOpen&&<>
    <div className="request-help-search"><label htmlFor="request-help-keyword">搜索关键词<Input id="request-help-keyword" disabled={busy} maxLength={200} value={independentKeyword(draft)} onChange={event=>change('searchKeyword',event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();if(connected&&!busy&&!searching)findRelated();}}} placeholder="目标、方法或环境"/></label><Button type="button" variant="outline" onClick={findRelated} disabled={busy||!connected||searching||!independentKeyword(draft).trim()}>查找</Button></div>
    {hasMaterialText(draft.title)&&<p className="request-help-note">来源材料不会自动用于搜索，可以单独填写关键词。</p>}{hasMaterialText(draft.searchKeyword)&&<p>旧检索字段含来源材料。<Button type="button" variant="ghost" onClick={()=>saveInput({...draftRef.current,searchKeyword:''})}>重新填写独立关键词</Button></p>}<details className="request-help-directions"><summary>也看看愿意交流的人</summary><label htmlFor="request-help-functions">想交流的方向<Input id="request-help-functions" disabled={busy} maxLength={1200} value={draft.searchFunctions??''} onChange={event=>change('searchFunctions',event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();if(connected&&!busy&&!searching)findRelated();}}} placeholder="例如：代码复核、手机端交互"/></label><p className="request-help-note">填入方向后再次查找，可以一并读取对方表达的交流意愿。</p></details>
    {!connected&&<p className="request-help-note">连接身份后可以查找，草稿会继续保留。</p>}
    {(preparation||searching||searchError||preparationChoice(draft.helpPreparation).selected.length>0)&&<TaskPreparationWorkspace {...{runtime,subjectId,connected}} value={preparation} selected={preparationChoice(draft.helpPreparation).selected} busy={searching} disabled={busy} error={searchError} onChange={rememberPreparation} onRetry={()=>void searchPreparation()}/>}
   </>}</section>
   {connected&&<TaskAgentIdentityPrompt {...{runtime,subjectId,connected}} navigate={navigateWithSavedDraft} onReady={setAgentReady}/>}
   <footer className="request-form-footer"><div><span aria-live="polite" aria-label="本机稿状态">{readingDraft?'正在读取草稿…':saveMessage}</span><button type="button" className="text-action" disabled={busy} onClick={()=>navigateWithSavedDraft(forumLocator?.returnTo??originLocator?.returnTo??'/app/')}>保存并离开</button></div><div className="button-row">
    <Button type="button" variant="ghost" disabled={busy||!!pending||!taskFieldPresent(draft.title)||!taskFieldPresent(draft.summary)} onClick={()=>void run(preparePreview)}><Eye size={16}/>预览</Button>
    {!connected?<Button type="button" disabled={busy||!!pending} onClick={()=>navigateWithSavedDraft('/app/settings/identity')}>登录并继续<ArrowRight size={15}/></Button>:agentReady&&<Button type="submit" disabled={busy||!!pending}>{busy?'正在发布…':draft.visibility==='Public'?'发布求助':'保存这项工作'}<ArrowRight size={15}/></Button>}
   </div></footer>
  </form>}

  {preview&&<article className="request-publication-preview"><div className="request-preview-meta">{preview.visibility==='Public'?<><Globe size={16}/>公开求助</>:<><Lock size={16}/>仅自己</>}<span>接受新回应至 {new Date(preview.enrollmentExpiresAt*1000).toLocaleString('zh-CN',{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'})}</span></div><h2>{displayPreview(preview.title,true)}</h2><p className="request-main-text">{displayPreview(preview.summary)}</p>{displayPreview(preview.workContext.goal)&&displayPreview(preview.workContext.goal)!==displayPreview(preview.title)&&<section><h3>具体目标</h3><p>{displayPreview(preview.workContext.goal)}</p></section>}{displayPreview(preview.workContext.currentSituation)!=='未另行提供当前情况。'&&displayPreview(preview.workContext.currentSituation)!==displayPreview(preview.summary)&&<section><h3>背景</h3><p>{displayPreview(preview.workContext.currentSituation)}</p></section>}{preview.expectedOutcome&&<section><h3>预期结果</h3><p>{displayPreview(preview.expectedOutcome)}</p></section>}{originPreview&&<div className="request-origin"><BookOpen size={17}/><span>关联：{originReview?.task.request.title??'原工作'}{originPreview.attemptRefs.length>0?` · ${originPreview.attemptRefs.length} 条已有尝试`:''}</span></div>}
   {!!preview.materials?.length&&<div className="message"><p>其中 {preview.materials.length} 段使用了你选定的帖子材料，撤回或到期后会停止展示相应文字。</p>{previewBlocked&&<p><output>部分材料正在核对或当前不可用，请核对来源后继续。</output></p>}<Button variant="ghost" disabled={busy} onClick={()=>void refreshMaterials()}>核对材料当前状态</Button></div>}
   {connected?<TaskAgentIdentityPrompt {...{runtime,subjectId,connected}} navigate={navigateWithSavedDraft} onReady={setAgentReady}/>:<div className="request-login"><p>登录后发布，当前草稿会保留。</p><Button onClick={()=>navigateWithSavedDraft('/app/settings/identity')}>登录并继续</Button></div>}
   <footer className="request-form-footer"><Button type="button" variant="ghost" disabled={busy} onClick={()=>setPreview(null)}><ArrowLeft size={15}/>继续修改</Button>{connected&&agentReady&&<Button type="button" disabled={busy||!!pending||previewBlocked} onClick={()=>void run(submit)}>{busy?'正在发布…':preview.visibility==='Public'?'发布求助':'保存这项工作'}<ArrowRight size={15}/></Button>}</footer>
  </article>}
  </>}
 </section>;
}
