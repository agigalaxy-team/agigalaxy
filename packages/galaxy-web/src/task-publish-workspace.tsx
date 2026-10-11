import React,{useEffect,useEffectEvent,useId,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {TaskOperationRecovery} from './task-operation-recovery';
import {ordinaryPublicationFromDraft,taskWriteError} from './task-bounty-client.mjs';
import {ArrowLeft,ArrowRight,BookOpen,Check,Globe,Lock,Search} from 'lucide-react';
import {createTaskPreparationClient} from './task-preparation-client.mjs';
import {TaskPreparationWorkspace} from './task-preparation-workspace';
import {contactCandidates} from './task-contact-client.mjs';
import './task-help-continuation.css';
import {AccountVerificationPrompt,needsAccountVerification} from './account-verification-prompt';
import {createHelpOriginClient,helpOriginLocator,helpOriginPayload} from './help-origin-client.mjs';
import {TaskOriginPicker} from './task-origin-workspace';
import {TaskAgentIdentityPrompt} from './task-agent-identity-prompt';
import {createCommunityForumClient} from './community-forum-client.mjs';
import {forumTaskLocator} from './community-forum-origin.mjs';
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
type BusinessFeedback={message:string;verificationRequired:boolean};
function draftFeedbackTitle(feedback:DraftFeedback){
 if(feedback.stage==='read-input')return '读取期间又有新输入，尚未保存。';
 const known:Record<string,string>={task_draft_conflict:'本机稿已在另一页面更改或清空。',task_draft_record_invalid:'本机稿的格式、版本或编号无法核对。',task_draft_legacy_comparison_unavailable:'旧稿中的数据无法完整核对，尚未安全转换。',task_draft_id_unavailable:'暂时无法准备本机稿件编号。',task_draft_revision_limit:'本机稿的修订次数已到上限。',task_draft_value_invalid:'本机稿的编辑字段无法保存。',task_draft_reload_required:'需要重新核对当前已保存的本机稿。',task_draft_adapter_required:'当前环境尚不能安全更新本机稿。',local_atomic_update_unavailable:'当前环境尚不能安全更新本机稿。',task_draft_lease_invalid:'当前本机稿的身份范围无法核对。'};
 if(known[taskEntryError(feedback.reason,'code')||taskEntryError(feedback.reason)])return known[taskEntryError(feedback.reason,'code')||taskEntryError(feedback.reason)];
 if(feedback.stage==='gate')return '本机稿尚未核对。';
 if(taskEntryError(feedback.reason,'name')==='AbortError')return feedback.stage==='read'?'浏览器中止了这次本机稿读取。':'浏览器中止了这次本机稿保存。';
 if(taskEntryError(feedback.reason,'name')==='QuotaExceededError')return '浏览器没有足够空间完成这次本机稿操作。';
 if(taskEntryError(feedback.reason,'name')==='DataCloneError')return '本机稿中的部分数据无法复制。';
 return feedback.stage==='read'?'本机稿尚未读取完成。':'这次本机稿保存未完成。';
}

type Props={runtime:TaskEntryRuntime|null;subjectId?:string;connected:boolean;navigate:(path:string)=>void;onNeedIdentity?:()=>void;registerShellNavigation?:(scopeKey:string,handler:(path:string)=>void)=>()=>void};
export function TaskPublishWorkspace(props:Props){
 const scope=props.runtime?.taskDraftScope();
 if(!props.runtime||!scope||scope.closed||scope.subjectId!==(props.subjectId??null))return <section aria-busy="true"><h1 className="small">发起一个请求</h1><p>正在读取当前身份的本机稿。</p></section>;
 return <TaskPublishSession key={scope.key} sessionKey={scope.key} {...props} runtime={props.runtime}/>;
}
function TaskPublishSession({runtime,subjectId,connected,navigate,registerShellNavigation,sessionKey}:Props&{runtime:TaskEntryRuntime;sessionKey:string}){

 const draftClient=useMemo(()=>runtime.createTaskDraftClient(),[runtime]);
 const preparationClient:TaskEntryPreparationClient|null=useMemo(()=>runtime&&connected?createTaskPreparationClient(runtime):null,[runtime,connected]);
 const originClient:HelpOriginClient|null=useMemo(()=>runtime&&connected?createHelpOriginClient(runtime):null,[runtime,connected]);
 const originLocator=helpOriginLocator(location.pathname+location.search+location.hash);
 const forumLocator=useMemo(()=>forumTaskLocator(location.pathname+location.search+location.hash),[]);
 const forumClient=useMemo(()=>runtime&&forumLocator?createCommunityForumClient(runtime,{subjectId:subjectId??null}):null,[runtime,forumLocator,subjectId]);
 const [forumSourceState,setForumSourceState]=useState('reading');
 useEffect(()=>{let active=true;if(forumClient&&forumLocator){forumClient.version(forumLocator.postId,forumLocator.versionId).then(value=>{if(active)setForumSourceState(value.availability==='available'?'available':'unavailable');}).catch(()=>{if(active)setForumSourceState('unknown');});}return()=>{active=false;forumClient?.close();};},[forumClient,forumLocator]);
 const [originPreview,setOriginPreview]=useState<HelpOriginSelection|null>(null),[originReview,setOriginReview]=useState<HelpOriginView|null>(null),[sourceRevision,setSourceRevision]=useState(0);
 const [preparation,setPreparation]=useState<PreparationView|null>(null),[searching,setSearching]=useState(false),[searchError,setSearchError]=useState('');
 const queryEpoch=useRef(0),confirmedQuery=useRef<PreparationInput|null>(null),queryWorking=useRef(false),preparationRef=useRef<PreparationView|null>(null);
 const [draft,setDraft]=useState(()=>readPublishDraft()),[loaded,setLoaded]=useState(false);
 const draftRef=useRef(draft),draftHead=useRef<TaskDraftHead|null>(null),inputRevision=useRef(0),draftReadEpoch=useRef(0),draftReading=useRef(true),draftReloadRequired=useRef(true);
 const [draftFeedback,setDraftFeedback]=useState<DraftFeedback|null>(null),[saveMessage,setSaveMessage]=useState(''),[readingDraft,setReadingDraft]=useState(true),[previewHead,setPreviewHead]=useState<TaskDraftHead|null>(null);
 const draftFeedbackRef=useRef<DraftFeedback|null>(null),draftErrorOrigins=useRef(new WeakMap<object,DraftFeedbackStage>()),savedInputRevision=useRef(0);
 const [preview,setPreview]=useState<TaskPublication|null>(null),[pending,setPending]=useState<unknown>(null),[busy,setBusy]=useState(false),[error,setErrorMessage]=useState(''),[notice,setNotice]=useState('');
 const [verificationRequired,setVerificationRequired]=useState(false);
 const businessFeedbackRef=useRef<BusinessFeedback>({message:'',verificationRequired:false});
 function localFailureStage(reason:unknown){return reason&&typeof reason==='object'?draftErrorOrigins.current.get(reason):undefined;}
 function markDraftFailure(reason:unknown,stage:DraftFeedbackStage){if(reason&&typeof reason==='object'&&!draftErrorOrigins.current.has(reason))draftErrorOrigins.current.set(reason,stage);return reason;}
 function showDraftFeedback(value:DraftFeedback|null){draftFeedbackRef.current=value;setDraftFeedback(value);}
 function showDraftFailure(stage:DraftFeedbackStage,reason:unknown,blocked=false){markDraftFailure(reason,stage);const prior=draftFeedbackRef.current;
  if(prior&&(stage==='gate'||taskEntryError(reason,'code')==='task_draft_reload_required')){showDraftFeedback({...prior,blocked:prior.blocked||blocked});return;}
  showDraftFeedback({stage,reason,blocked:blocked||!!(prior&&prior.reason===reason&&prior.blocked)});}
 function showBusinessFeedback(value:BusinessFeedback){businessFeedbackRef.current=value;setErrorMessage(value.message);setVerificationRequired(value.verificationRequired);}
 function setError(reason:unknown){const stage=localFailureStage(reason);if(stage){showDraftFailure(stage,reason,true);return;}showBusinessFeedback({message:typeof reason==='string'?reason:taskWriteError(reason),verificationRequired:needsAccountVerification(reason)});}
 const [step,setStep]=useState(()=>new URLSearchParams(location.search).get('step')==='review'?1:0),[lastReceipt,setLastReceipt]=useState<OperationReceipt|null>(null),[backgroundOpen,setBackgroundOpen]=useState(false),[referenceSearchOpen,setReferenceSearchOpen]=useState(false),[agentReady,setAgentReady]=useState(false);
 const restoredReview=useRef(false);
 const flowTop=useRef<HTMLElement>(null),lastFlowPhase=useRef<string|null>(null);
 const flowPhase=preview?'preview':String(step);
 useEffect(()=>{const phase=flowPhase;if(lastFlowPhase.current!==null&&phase!==lastFlowPhase.current)flowTop.current?.scrollIntoView({block:'start'});lastFlowPhase.current=phase;},[flowPhase]);
 const recoveringPublication=useRef(false);
 const epoch=useRef(0),working=useRef(false);
 const current=()=>{try{draftClient.check();return true;}catch{return false;}};
 const navigationHandler=useRef<(path:string)=>void>(()=>{});
 useLayoutEffect(()=>{navigationHandler.current=navigateWithSavedDraft;});
 useLayoutEffect(()=>registerShellNavigation?.(sessionKey,path=>navigationHandler.current(path)),[registerShellNavigation,sessionKey]);
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
 function prepareNext(){setStep(1);}
 function findRelated(){const input={keyword:(draftRef.current.searchKeyword??draftRef.current.title).trim(),functions:(draftRef.current.searchFunctions??'').split(/[,，\n]/).map((value:string)=>value.trim()).filter(Boolean),capabilityId:draftRef.current.capabilityId.trim()};confirmedQuery.current=input;change('helpPreparation',{...preparationChoice(draftRef.current.helpPreparation),input,open:true});void searchPreparation(input);}
 async function readLocalDraft(){const token=epoch.current,ticket=++draftReadEpoch.current,revision=inputRevision.current;draftReading.current=true;draftReloadRequired.current=true;
  try{const value=await draftClient.load();if(token!==epoch.current||!current()||ticket!==draftReadEpoch.current)return;
   if(revision!==inputRevision.current){showDraftFailure('read-input',null);setSaveMessage('本页新输入尚未保存。');return;}
   const next=readPublishDraft(value?.value??{});draftRef.current=next;draftHead.current=value?.head??null;savedInputRevision.current=revision;setDraft(next);setPreview(null);setPreviewHead(null);setOriginPreview(null);setOriginReview(null);setLoaded(true);draftReloadRequired.current=false;showDraftFeedback(null);setSaveMessage(value?'本机稿已读取。':'输入后会自动保存到此浏览器。');queryEpoch.current++;queryWorking.current=false;setPreparation(null);preparationRef.current=null;setSearching(false);setSearchError('');const preparation=preparationChoice(next.helpPreparation);setReferenceSearchOpen(preparation.open);confirmedQuery.current=preparation.input;if(preparation.input)void searchPreparation(preparation.input);
  }catch(reason:unknown){if(token===epoch.current&&current()&&ticket===draftReadEpoch.current){showDraftFailure('read',reason);setSaveMessage('尚未读取本机版本。');}}
  finally{if(token===epoch.current&&current()&&ticket===draftReadEpoch.current){draftReading.current=false;setReadingDraft(false);}}}
 async function flushDraft(){if(draftReading.current||draftReloadRequired.current)throw markDraftFailure(Error('本页输入尚未安全保存，请先处理本机稿提示。'),'gate');try{await draftClient.flush();}catch(reason){throw markDraftFailure(reason,'save');}}
 async function run(fn:(valid:()=>boolean)=>Promise<void>){if(working.current)return;const token=epoch.current,valid=()=>token===epoch.current&&current(),previousBusinessFeedback=businessFeedbackRef.current;working.current=true;setBusy(true);setError('');setNotice('');try{await fn(valid);}catch(e){if(valid()){if(localFailureStage(e)&&!businessFeedbackRef.current.message&&previousBusinessFeedback.message)showBusinessFeedback(previousBusinessFeedback);setError(e);}}finally{if(valid()){try{const p=await runtime.getLocal('task-publication',draftClient.ownerKey);if(valid())setPending(p);}catch{}if(valid()){working.current=false;setBusy(false);}}}}
 function navigateWithSavedDraft(path:string){void run(async valid=>{await flushDraft();if(valid()){if(preview&&path.startsWith('/app/settings/identity')){const current=new URL(location.href);current.searchParams.set('step','review');history.replaceState(history.state,'',current.pathname+current.search+current.hash);}navigate(path);}});}
 function change<K extends keyof PublishDraft>(field:K,value:PublishDraft[K]){const next={...draftRef.current,[field]:value},revision=++inputRevision.current,ticket=draftReadEpoch.current,token=epoch.current;draftRef.current=next;setDraft(next);setPreview(null);setPreviewHead(null);setOriginPreview(null);setOriginReview(null);
  if(draftReading.current||draftReloadRequired.current){setSaveMessage('本页新输入尚未保存。');return;}
  setSaveMessage('正在保存到此浏览器…');void draftClient.save(next).then(saved=>{if(token!==epoch.current||!current()||ticket!==draftReadEpoch.current)return;draftHead.current=saved.head;if(revision===inputRevision.current){savedInputRevision.current=revision;setSaveMessage('已保存到此浏览器。');showDraftFeedback(null);}}).catch((reason:unknown)=>{if(token===epoch.current&&current()&&ticket===draftReadEpoch.current){draftReloadRequired.current=true;showDraftFailure('save',reason);setSaveMessage('本页新输入尚未保存，仍保留在编辑框中。');}});}

 async function finish(receipt:OperationReceipt){const id=receipt.taskId??receipt.result?.taskId;if(!id)return;const token=epoch.current,revision=inputRevision.current;let unsaved=draftReading.current||draftReloadRequired.current;try{await draftClient.flush();}catch{unsaved=true;}if(token!==epoch.current||!current())return;unsaved=unsaved||revision!==inputRevision.current;setPreview(null);setPreviewHead(null);
  if(unsaved||receipt.localDraftCleanup?.state==='failed'){setLastReceipt({taskId:id});setNotice(unsaved?'任务已被服务接受。':'任务已被服务接受。本机草稿暂未清理，原内容仍保留；可以再次核对回执，或直接打开已创建的任务。');return;}navigate(`/app/tasks/${id}?section=collaboration`);}
 async function reviewOrigin(selection:HelpOriginSelection|null,valid:()=>boolean){if(!selection)return null;if(!originClient)throw Error('请先连接原身份，再核对所选原工作。');try{const value=await originClient.validate(selection);return valid()?value:null;}catch(error){if(valid()){setOriginReview(null);setOriginPreview(null);setPreview(null);setStep(0);setSourceRevision(value=>value+1);}throw error;}}
 async function preparePreview(valid:()=>boolean){const selectedDraft=structuredClone(draftRef.current),revision=inputRevision.current;await flushDraft();if(!valid()||revision!==inputRevision.current)return;const selectedHead=structuredClone(draftHead.current);if(!selectedHead)throw Error('请先保存这份本机稿，再预览发布。');const selected=selectedDraft.helpOrigin?structuredClone(selectedDraft.helpOrigin):null,current=await reviewOrigin(selected,valid);if(!valid()||revision!==inputRevision.current)return;setOriginPreview(selected);setOriginReview(current);setPreviewHead(selectedHead);setPreview(ordinaryPublicationFromDraft({...selectedDraft,goal:selectedDraft.goal.trim()||selectedDraft.title.trim(),situation:selectedDraft.situation.trim()||'未另行提供当前情况。'}));}
 async function submit(valid:()=>boolean){if(!preparationClient)throw Error('请先连接当前身份。');if(!preview)throw Error('请先预览这份求助。');const selectedPreview=structuredClone(preview),selectedHead=structuredClone(previewHead);if(!selectedHead)throw Error('本机稿修订尚未核对，请重新预览。');await flushDraft();if(!valid())return;if(originPreview){const current=await reviewOrigin(originPreview,valid);if(!valid())return;const refs=helpOriginPayload(originPreview);if(selectedPreview.caseId!==refs.caseId||selectedPreview.parentTaskId!==refs.parentTaskId||JSON.stringify(selectedPreview.workContext.attemptRefs)!==JSON.stringify(refs.attemptRefs))throw Error('原工作引用与待发布预览不一致，请重新预览。');setOriginReview(current);}const choice=preparationChoice(draftRef.current.helpPreparation),prepared=choice.input&&choice.selected.length?await readPreparation(preparationClient,runtime,choice.input,choice,valid):preparationRef.current;if(!valid())return;await preparationClient.freeze(selectedPreview,prepared,originPreview?{taskId:originPreview.taskId,returnTo:originPreview.returnTo??`/app/tasks/${originPreview.taskId}?section=collaboration`}:null);if(!valid())return;const receipt=readOperationReceipt(await runtime.publishTask(selectedPreview,{confirmed:true,forumOrigin:forumLocator,draftHead:selectedHead}));if(valid())await finish(receipt);}
 const restoreReview=useEffectEvent(()=>{if(loaded&&!restoredReview.current&&new URLSearchParams(location.search).get('step')==='review'){restoredReview.current=true;void run(preparePreview);}});
 useEffect(()=>{restoreReview();},[loaded]);
 const fieldId=useId();
 const visibilityOptions=[['Public','公开求助','其他人可以发现、阅读并回应',Globe],['Private','仅自己','先保留为自己的工作',Lock]] as const;
 const hasUnsavedInput=loaded&&inputRevision.current!==savedInputRevision.current;
 const draftDiagnostic=draftFeedback?.reason,diagnosticText=taskEntryError(draftDiagnostic)?taskEntryError(draftDiagnostic):typeof draftDiagnostic==='string'?draftDiagnostic:'',diagnosticCode=[taskEntryError(draftDiagnostic,'code'),taskEntryError(draftDiagnostic,'name')].filter(Boolean).join(' · ');
 return <section ref={flowTop} className="request-compose-page" aria-busy={busy}>
  <header className="request-compose-heading"><div><p className="eyebrow">一起推进一件事</p><h1 className="small">发起求助</h1></div>{!pending&&lastReceipt&&<a href={`/app/tasks/${lastReceipt.taskId}`} onClick={event=>{event.preventDefault();navigateWithSavedDraft(`/app/tasks/${lastReceipt.taskId}`);}}>上次发布 <ArrowRight size={14}/></a>}</header>
  {forumLocator&&<div className="request-origin"><BookOpen size={17}/><a href={forumLocator.returnTo} onClick={event=>{event.preventDefault();navigateWithSavedDraft(forumLocator.returnTo);}}>来自一段社区讨论</a>{forumSourceState==='unavailable'&&<span>原帖暂不可读</span>}</div>}
  {error&&<div className="message error" role="alert">{error}<AccountVerificationPrompt required={verificationRequired} navigate={navigateWithSavedDraft}/></div>}{notice&&<output className="message">{notice}</output>}
  {draftFeedback&&<div className="message error" role="alert" aria-label="本机稿提示"><p><strong>{draftFeedbackTitle(draftFeedback)}</strong>{hasUnsavedInput&&' 未保存的文字仍在编辑框中。'}</p><p>先保留需要的文字，再读取这台设备上的最新草稿。</p><Button type="button" disabled={busy||readingDraft} onClick={()=>{setReadingDraft(true);showDraftFeedback(null);void readLocalDraft();}}>读取已保存的草稿</Button>{(diagnosticCode||diagnosticText)&&<details><summary>错误详情</summary><p style={{overflowWrap:'anywhere'}}>{diagnosticCode}{diagnosticCode&&diagnosticText?'：':''}{diagnosticText}</p></details>}</div>}
  <TaskOperationRecovery runtime={runtime} connected={connected} onComplete={finish} onStopped={()=>{setPending(null);setPreview(null);setNotice('已停止本机重试，草稿仍保留。');}}/>
  {loaded&&<><nav className="request-steps" aria-label="求助发布步骤"><button type="button" aria-current={step===0&&!preview?'step':undefined} onClick={()=>{setStep(0);setPreview(null);}}><span>{step>0||preview?<Check size={13}/>:1}</span>说明目标</button><button type="button" aria-current={step===1&&!preview?'step':undefined} disabled={!draft.title.trim()||!draft.summary.trim()} onClick={()=>{setStep(1);setPreview(null);}}><span>{preview?<Check size={13}/>:2}</span>选择范围</button><span aria-current={preview?'step':undefined}><span>3</span>预览发布</span></nav>
  {!preview&&<form className="request-compose-form" onSubmit={event=>{event.preventDefault();if(step===0){prepareNext();return;}void run(preparePreview);}}>
   {step===0&&<fieldset disabled={busy}><label htmlFor={fieldId+'-title'}>想做什么？<Input id={fieldId+'-title'} required maxLength={120} value={draft.title} onChange={event=>change('title',event.target.value)} placeholder="用一句话说说你的目标"/></label><label htmlFor={fieldId+'-summary'}>需要怎样的帮助？<Textarea id={fieldId+'-summary'} required maxLength={10000} value={draft.summary} onChange={event=>change('summary',event.target.value)} placeholder="可以说说现在的进展、遇到的问题，或想邀请大家一起尝试的事。"/></label>
    <button className="text-action" type="button" aria-expanded={backgroundOpen} onClick={()=>setBackgroundOpen(value=>!value)}>{backgroundOpen?'收起补充内容':'添加背景或预期结果'}</button>
    {backgroundOpen&&<div className="request-extra-fields"><label htmlFor={fieldId+'-goal'}>更具体的目标<Textarea id={fieldId+'-goal'} maxLength={10000} value={draft.goal} onChange={event=>change('goal',event.target.value)} placeholder="可选"/></label><label htmlFor={fieldId+'-situation'}>当前情况与环境<Textarea id={fieldId+'-situation'} maxLength={10000} value={draft.situation} onChange={event=>change('situation',event.target.value)} placeholder="可选，写下理解这项工作需要的背景"/></label><label htmlFor={fieldId+'-expectedOutcome'}>希望得到的结果<Textarea id={fieldId+'-expectedOutcome'} maxLength={1500} value={draft.expectedOutcome} onChange={event=>change('expectedOutcome',event.target.value)} placeholder="可选，例如一份建议、可以运行的修改或一次复核"/></label><label htmlFor={fieldId+'-intent'}>帮助方式<select id={fieldId+'-intent'} value={draft.intent} onChange={event=>change('intent',event.target.value)}><option value="collaboration">一起完成</option><option value="stuck">解决困难</option><option value="proactive-review">评审建议</option><option value="diagnosis">诊断问题</option><option value="delegation">委托一项工作</option></select></label></div>}
    <TaskOriginPicker {...{runtime,connected,busy,sourceRevision}} navigate={navigateWithSavedDraft} locator={originLocator} selection={draft.helpOrigin??null} onChange={(value:HelpOriginSelection|null)=>change('helpOrigin',value)}/>
   </fieldset>}
   {step===1&&<fieldset disabled={busy}><legend>谁可以看到这份求助？</legend><div className="request-visibility">{visibilityOptions.map(([value,title,description,Icon])=><label htmlFor={fieldId+value} className={draft.visibility===value?'selected':''} key={value}><input id={fieldId+value} type="radio" name="request-visibility" checked={draft.visibility===value} onChange={()=>change('visibility',value)}/><Icon size={23}/><span><strong>{title}</strong><small>{description}</small></span><span className="choice-indicator"/></label>)}</div><p className="request-field-note">这里只包含你在本页填写的内容。共享其他资料时，另行选择。</p><label htmlFor={fieldId+'-enrollment'}>接受新回应直到<Input id={fieldId+'-enrollment'} required type="datetime-local" value={draft.enrollmentLocal} onChange={event=>change('enrollmentLocal',event.target.value)}/><small>已有的交流与参与可以继续。</small></label></fieldset>}
   {step===0&&<section className="request-related request-related-help"><button type="button" className="text-action" disabled={busy} aria-expanded={referenceSearchOpen} onClick={toggleRelated}><Search size={16}/>看看已有的相关帮助{preparationChoice(draft.helpPreparation).selected.length?' · 已记下 '+preparationChoice(draft.helpPreparation).selected.length+' 位':''}</button>{referenceSearchOpen&&<>
    <div className="request-help-search"><label htmlFor="request-help-keyword">搜索关键词<Input id="request-help-keyword" disabled={busy} maxLength={200} value={draft.searchKeyword??draft.title} onChange={event=>change('searchKeyword',event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();if(connected&&!busy&&!searching)findRelated();}}} placeholder="目标、方法或环境"/></label><Button type="button" variant="outline" onClick={findRelated} disabled={busy||!connected||searching||!(draft.searchKeyword??draft.title).trim()}>查找</Button></div>
    <details className="request-help-directions"><summary>也看看愿意交流的人</summary><label htmlFor="request-help-functions">想交流的方向<Input id="request-help-functions" disabled={busy} maxLength={1200} value={draft.searchFunctions??''} onChange={event=>change('searchFunctions',event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();if(connected&&!busy&&!searching)findRelated();}}} placeholder="例如：代码复核、手机端交互"/></label><p className="request-help-note">填入方向后再次查找，可以一并读取对方表达的交流意愿。</p></details>
    {!connected&&<p className="request-help-note">连接身份后可以查找，草稿会继续保留。</p>}
    {(preparation||searching||searchError||preparationChoice(draft.helpPreparation).selected.length>0)&&<TaskPreparationWorkspace {...{runtime,subjectId,connected}} value={preparation} selected={preparationChoice(draft.helpPreparation).selected} busy={searching} disabled={busy} error={searchError} onChange={rememberPreparation} onRetry={()=>void searchPreparation()}/>}
   </>}</section>}
   <footer className="request-form-footer"><div><span aria-live="polite" aria-label="本机稿状态">{readingDraft?'正在读取草稿…':saveMessage}</span><button type="button" className="text-action" disabled={busy} onClick={()=>navigateWithSavedDraft(forumLocator?.returnTo??originLocator?.returnTo??'/app/')}>保存并离开</button></div><div className="button-row">{step===1&&<Button type="button" variant="ghost" onClick={()=>setStep(0)}><ArrowLeft size={15}/>上一步</Button>}<Button type="submit" disabled={busy||!!pending}>{step===0?'继续':'预览求助'}<ArrowRight size={15}/></Button></div></footer>
  </form>}

  {preview&&<article className="request-publication-preview"><div className="request-preview-meta">{preview.visibility==='Public'?<><Globe size={16}/>公开求助</>:<><Lock size={16}/>仅自己</>}<span>接受新回应至 {new Date(preview.enrollmentExpiresAt*1000).toLocaleString('zh-CN',{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'})}</span></div><h2>{preview.title}</h2><p className="request-main-text">{preview.summary}</p>{preview.workContext.goal!==preview.title&&<section><h3>具体目标</h3><p>{preview.workContext.goal}</p></section>}{preview.workContext.currentSituation!=='未另行提供当前情况。'&&<section><h3>背景</h3><p>{preview.workContext.currentSituation}</p></section>}{preview.expectedOutcome&&<section><h3>预期结果</h3><p>{preview.expectedOutcome}</p></section>}{originPreview&&<div className="request-origin"><BookOpen size={17}/><span>关联：{originReview?.task.request.title??'原工作'}{originPreview.attemptRefs.length>0?` · ${originPreview.attemptRefs.length} 条已有尝试`:''}</span></div>}
   {connected?<TaskAgentIdentityPrompt {...{runtime,subjectId,connected}} navigate={navigateWithSavedDraft} onReady={setAgentReady}/>:<div className="request-login"><p>登录后发布，当前草稿会保留。</p><Button onClick={()=>navigateWithSavedDraft('/app/settings/identity')}>登录并继续</Button></div>}
   <footer className="request-form-footer"><Button type="button" variant="ghost" disabled={busy} onClick={()=>{setPreview(null);setStep(0);}}><ArrowLeft size={15}/>继续修改</Button>{connected&&agentReady&&<Button type="button" disabled={busy||!!pending} onClick={()=>void run(submit)}>{busy?'正在发布…':preview.visibility==='Public'?'发布求助':'保存这项工作'}<ArrowRight size={15}/></Button>}</footer>
  </article>}
  </>}
 </section>;
}
