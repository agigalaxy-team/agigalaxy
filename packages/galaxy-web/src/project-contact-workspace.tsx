import { ReadingDetails, ReadingSummary } from './reading-details';
import {useCurrentTaskMaterialTree,TaskCurrentTitle} from './task-material-view';
import React, { useEffect, useEffectEvent, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FactDetails } from './fact-details';
import { getProjectContactClient } from './project-contact-client.mjs';
import { createProjectViewClient,projectViewScope,projectQueryMemory,opportunityUnavailable,opportunityLocator } from './project-view-client.mjs';
import {ContactSourceLinks} from './contact-origin-workspace';
import {MemberAvatar,memberName,readableTime,useMemberNames} from './conversation-ui';
import {useGovernanceDraft} from './governance-presentation';
import {ProjectContactPreferences} from './project-contact-preferences';
import './project-people-selection.css';
import './project-contact-workspace.css';
import {checkedProjectCompose,discoveryPurpose,object,projectErrorFlag,projectErrorNumber,projectErrorText,projectFormFor,recruitmentFormFor,savedDiscoveryForm,projectRole,isProjectForm,isRecruitmentForm,recruitmentExpiry} from './project-workspace-types';
import type {ProjectRuntime,ProjectContactClient,ProjectViewClient,ProjectView,RecruitmentView,ContactView,ProjectPage,RecruitmentPage,ContactsPage,VisibleOpportunity,Opportunity,OpportunityDetail,DiscoveryQuery,DiscoveryForm,ProjectForm,RecruitmentForm,PendingProjectOperation,OriginalProjectOperation,PreferencesView,ProjectPreferencesView,TaskChoice,Quota,Confirmation,ContactEvent,ProjectChoice,ComposeLane,ComposeValue,ComposeMarker,ProjectSelection,ProjectPeopleForm,ProjectSelectionLocator,SendResult} from './project-workspace-types';

const tags = (x: string) => [
  ...new Set(
    x
      .split(/[,，、\n]/)
      .map((v) => v.trim())
      .filter(Boolean),
  ),
];
const purposeNames: Record<string,string> = {
  conversation: '普通交流',
  reuse: '了解复用',
  collaboration: '共同协作',
  recruitment: '了解招募',
};
const blankProject:ProjectForm = {
  kind: 'project',
  title: '',
  summary: '',
  functions: '',
  technologies: '',
  sourceUrl: '',
  participantKind: 'unknown',
  discoverable: false,
};
const blankRecruitment:RecruitmentForm = {
  title: '',
  role: '',
  summary: '',
  functions: '',
  technologies: '',
  conditions: '',
  days: 30,
};
const stateNames: Record<string,string> = {
  sent: '已发送，等待对方回应',
  accepted: '双方已接受交流',
  declined: '已拒绝',
  withdrawn: '发起者已撤回',
  expired: '已到期',
  active: '进行中',
  paused: '已暂停',
  closed: '已关闭',
  awaiting_distinct_control: '等待独立控制主体确认',
};
const contactEventNames:Record<string,string>={send:'发起联系',accept:'接受交流',decline:'拒绝联系',withdraw:'撤回联系'};
const recruitProjectEligible=(item:ProjectView|null)=>!!(item?.document&&item.permissions?.represent&&item.visibility==='Public'&&item.state==='active');
const operationWait=(value:unknown)=>object(value)&&object(value.wait)?value.wait:object(value)?value:{};
function operationWaitText(value:unknown){const wait=operationWait(value);if(!(typeof wait.reason==='string'&&['quota-wait','cooldown-wait'].includes(wait.reason)))return '';const until=typeof wait.retryAt==='string'&&Number.isFinite(Date.parse(wait.retryAt))?new Date(wait.retryAt).toLocaleString('zh-CN'):null;const code=wait.rejectionCode??wait.code;return(wait.reason==='cooldown-wait'?'服务要求等待后再继续。':code==='community_restricted'?'当前账号暂时不能进行这类操作。':'这类操作的当前可用次数已用完。')+(until?'服务显示可在 '+until+' 后继续。':'服务尚未给出可继续的时间。')+'原内容已保留，页面会继续核对。';}
function operationWaiting(value:unknown,now:number){const wait=operationWait(value);return typeof wait.reason==='string'&&['quota-wait','cooldown-wait'].includes(wait.reason)&&(typeof wait.retryAt!=='string'||!Number.isFinite(Date.parse(wait.retryAt))||Date.parse(wait.retryAt)>now);}
const operationKindNames:Record<string,string>={create:'新增',revise:'更新介绍','grant-role':'授予协作角色','revoke-role':'撤销协作角色','offer-transfer':'邀请接手管理','accept-transfer':'接受管理转交','cancel-transfer':'取消管理转交',archive:'归档',restore:'恢复',send:'发起联系',accept:'接受交流',decline:'拒绝联系',withdraw:'撤回联系',renew:'续期招募',pause:'暂停招募',close:'关闭招募','link-task':'关联已有求助'};
const projectRoleNames:Record<string,string>={editor:'资料编辑',representative:'对外代表'};
const projectRoleDetails:Record<string,string>={editor:'可以更新这个项目的介绍。',representative:'可以代表这个项目对外联系，并为公开项目发布持续招募。'};
async function projectSelectionReceipt(client:ProjectContactClient,projectId:string,locator:ProjectSelectionLocator){
  if(locator?.kind!=='project-management'||locator.projectId!==projectId||typeof locator.operationId!=='string')return{state:'unknown'};
  const result=await client!.reviewPending(locator.operationId);
  return result?.state==='acknowledged'&&result.type==='project'&&result.objectId===projectId&&result.operationId===locator.operationId?{state:'acknowledged'}:{state:'unknown'};
}
function SavedOperationContent({review,name}:{review:OriginalProjectOperation;name:(id:string)=>string}){
 const value=review.payload,document='document' in value?value.document:'patch' in value?value.patch:null;
 const context='context' in value&&value.context.kind==='ephemeral'?value.context:null;
 const role=document&&'role' in document&&typeof document.role==='string'?document.role:'',conditions=document&&'conditions' in document&&typeof document.conditions==='string'?document.conditions:'';
 return <><p>{operationKindNames[value.kind]??'提交这次内容'} · {({project:'项目',recruitment:'持续招募',contact:'联系邀请'} as Record<string,string>)[review.type]}</p>
  {document&&<><h3>{document.title??'原项目内容'}</h3>{document.summary&&<p className="reading-prose">{document.summary}</p>}{role&&<p>角色：{role}</p>}{document.functions&&<p>方向：{document.functions.join('、')}</p>}{(document.technologies?.length??0)>0&&<p>工具与技术：{document.technologies?.join('、')}</p>}{conditions&&<p className="reading-prose">{conditions}</p>}{'sourceUrl' in document&&typeof document.sourceUrl==='string'&&document.sourceUrl&&<p>来源地址：{document.sourceUrl}</p>}{'discoverable' in document&&typeof document.discoverable==='boolean'&&<p>{document.discoverable?'允许参与发现':'不参与新的发现'}</p>}</>}
  {'context' in value&&<><h3>{context?.title??'交流背景'}</h3><p>{context?.functions.join('、')}</p>{!!context?.technologies.length&&<p>{context.technologies.join('、')}</p>}</>}
  {'recipientId' in value&&<p>接收者：{name(value.recipientId)}</p>}{'purpose' in value&&<p>交流目的：{purposeNames[value.purpose]??value.purpose}</p>}{'note' in value&&value.note&&<p className="reading-prose">{value.note}</p>}{'roomTitle' in value&&<p>对方接受后的聊天名称：{value.roomTitle}</p>}
  {'subjectId' in value&&<p>参与者：{name(value.subjectId)} · {value.role==='editor'?'资料编辑':'对外代表'}</p>}{'toSubjectId' in value&&<p>邀请接手者：{name(value.toSubjectId)}</p>}{'taskId' in value&&<p>关联求助：{value.taskId}</p>}{'expiresAt' in value&&<p>有效至 {readableTime(value.expiresAt*1000)}</p>}
  <p>{review.visibility==='Public'?'公开分享':'分享给你'+(review.viewers.length?'和 '+review.viewers.map(name).join('、'):'')}</p>
  <ReadingDetails className="technical-details"><ReadingSummary>原内容与准确记录</ReadingSummary><p>{review.operationId} · {review.payloadHash}</p><pre>{JSON.stringify(value,null,2)}</pre></ReadingDetails>
 </>;
}
function ProjectTextField({label,value,onChange,multiline=false,disabled,required,maxLength}:{label:string;value:string;onChange:(value:string)=>void;multiline?:boolean;disabled:boolean;required:boolean;maxLength:number}){
 const id=useId();return <label htmlFor={id}>{label}{multiline?<Textarea id={id} disabled={disabled} required={required} maxLength={maxLength} value={value} onChange={event=>onChange(event.target.value)}/>:<Input id={id} disabled={disabled} required={required} maxLength={maxLength} value={value} onChange={event=>onChange(event.target.value)}/>}</label>;
}
type Props = {
  runtime: ProjectRuntime;
  subjectId: string | null | undefined;
  connected: boolean;
  navigate: (path: string) => void;
  initialTab?: string;
  initialProjectId?: string;
  initialContactId?: string;
};
export function ProjectContactWorkspace(props:Props) {
  return <ProjectContactView key={JSON.stringify([props.subjectId,projectViewScope(props.runtime,props.connected)])} {...props}/>;
}
function ProjectContactView({
  runtime,
  subjectId,
  connected,
  navigate,
  initialTab='discover',
  initialProjectId,
  initialContactId,
}: Props) {
  const client = useMemo<ProjectContactClient|null>(
    () =>
      runtime && subjectId ? getProjectContactClient(runtime, subjectId) : null,
    [runtime, subjectId],
  );
  const viewClient=useMemo<ProjectViewClient|null>(()=>runtime?createProjectViewClient(runtime,{connected,subjectId}):null,[runtime,connected,subjectId]);
  const [draft]=useState(()=>{const saved:unknown=projectQueryMemory(runtime,connected,'contact-list');return object(saved)?saved:null;});
  const [tabSelection,setTabSelection]=useState({requested:initialTab,selected:['discover','projects','recruitment','contacts','willingness'].includes(initialTab)?initialTab:'discover'});
  const tab=tabSelection.requested===initialTab?tabSelection.selected:['discover','projects','recruitment','contacts','willingness'].includes(initialTab)?initialTab:'discover';
  const setTab=(selected:string)=>setTabSelection({requested:initialTab,selected});
  const [now,setNow]=useState(()=>Date.now()),fieldId=useId();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const [pending, setPending] = useState<PendingProjectOperation[]>([]),
    [query, setQuery] = useState<DiscoveryForm>(savedDiscoveryForm(draft?.query)??{
      title: '',
      functions: '',
      technologies: '',
      purpose: 'conversation',
    }),
    [submitted, setSubmitted] = useState<DiscoveryQuery|null>(null);
  const [opportunities, setOpportunities] = useState<VisibleOpportunity[]>([]),
    [queryNext, setQueryNext] = useState<string | null>(null),
    [searched, setSearched] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [detail, setDetail] = useState<OpportunityDetail|null>(null);
  const [note, setNote] = useState(typeof draft?.note==='string'?draft.note:''),
    [roomTitle, setRoomTitle] = useState(typeof draft?.roomTitle==='string'?draft.roomTitle:'银河交流'),
    [sendResults, setSendResults] = useState<SendResult[]>([]);
  const [sourceDenied,setSourceDenied]=useState(false);
  const [projects, setProjects] = useState<ProjectView[]>([]),
    [projectNext, setProjectNext] = useState<string | null>(null),
    [project, setProject] = useState<ProjectView|null>(null),
    [projectForm, setProjectForm] = useState<ProjectForm>(blankProject);
  const [visibility, setVisibility] = useState('Private'),
    [viewers, setViewers] = useState('');
  const [recruits, setRecruits] = useState<RecruitmentView[]>([]),
    [recruitNext, setRecruitNext] = useState<string | null>(null),
    [recruit, setRecruit] = useState<RecruitmentView|null>(null),
    [recruitProjectId, setRecruitProjectId] = useState(''),
    [recruitForm, setRecruitForm] = useState<RecruitmentForm>(blankRecruitment),
    [taskId, setTaskId] = useState('');
  const [contactItems, setContacts] = useState<ContactView[]>([]),
    [contactNextValue, setContactNext] = useState<string | null>(null),
    [direction, setDirection] = useState('both'),
    [responseNotes, setResponseNotes] = useState<Record<string, string>>({});
  const [contactsStateValue,setContactsState]=useState<'idle'|'loading'|'ready'|'failed'>('idle'),[contactsKey,setContactsKey]=useState('');
  const contactContext=JSON.stringify([direction,initialContactId]),contacts=contactsKey===contactContext?contactItems:[],contactNext=contactsKey===contactContext?contactNextValue:null,contactsState=contactsKey===contactContext?contactsStateValue:tab==='contacts'&&connected?'loading':'idle';
  const contactsRequest=useRef(0);
  const [discoveryPreferences, setDiscoveryPreferences] = useState<PreferencesView|null>(null),
    [projectPreferences, setProjectPreferences] = useState<ProjectPreferencesView|null>(null);
  const [projectMode,setProjectMode]=useState<'list'|'read'|'edit'|'roles'|'transfer'|'preferences'>('list'),[projectStep,setProjectStep]=useState(0);
  const [recruitMode,setRecruitMode]=useState<'list'|'read'|'edit'|'link'>('list'),[recruitStep,setRecruitStep]=useState(0);
  const [confirmation,setConfirmation]=useState<Confirmation|null>(null),[contactReply,setContactReply]=useState<{contact:ContactView;kind:Exclude<ContactEvent["kind"],"send">}|null>(null),[detailOpen,setDetailOpen]=useState(false);
  const [pendingReview,setPendingReview]=useState<OriginalProjectOperation|null>(null),[pendingNotes,setPendingNotes]=useState<Record<string,string>>({});
  const [projectsLoaded,setProjectsLoaded]=useState(false),[recruitsLoaded,setRecruitsLoaded]=useState(false);
  const [readTasks,setTasks]=useState<TaskChoice[]>([]),[taskNext,setTaskNext]=useState<string|null>(null);
 const tasks=useCurrentTaskMaterialTree(runtime,readTasks)??[];
  const previewDialog=useRef<HTMLDialogElement>(null),contactDialog=useRef<HTMLDialogElement>(null),detailDialog=useRef<HTMLDialogElement>(null),pendingDialog=useRef<HTMLDialogElement>(null);
  const working=useRef(false);
  const projectReadEpoch=useRef(0);
  const [newProjectId,setNewProjectId]=useState<string>(()=>crypto.randomUUID()),[newRecruitmentId,setNewRecruitmentId]=useState<string>(()=>crypto.randomUUID());
  const writable = !!(connected && subjectId && client);
  const composeLease=useMemo(()=>writable?runtime.receiptStatus.captureLease():null,[runtime,writable]);
  const compose=useRef<Record<'project'|'recruitment',ComposeLane|null>>({project:null,recruitment:null}),composeMounted=useRef(true);
  const [composeStatus,setComposeStatus]=useState({project:'',recruitment:''}),[composeReady,setComposeReady]=useState({project:false,recruitment:false});
  const [audienceIds,setAudienceIds]=useState<string[]>([]),[audienceAfter,setAudienceAfter]=useState<string|null>(null),[audienceLoaded,setAudienceLoaded]=useState(false),[audienceError,setAudienceError]=useState(''),[audienceSearch,setAudienceSearch]=useState('');
  const [recruitProjectCheck,setRecruitProjectCheck]=useState<{id:string;state:'idle'|'reading'|'ready'|'failed';message?:string}>({id:'',state:'idle'}),[recruitProjectRead,setRecruitProjectRead]=useState(0),[publicationQuota,setPublicationQuota]=useState<Quota|null>(null);
  useEffect(()=>{composeMounted.current=true;return()=>{composeMounted.current=false;};},[]);
  const viewScope=projectViewScope(runtime,connected);
  const checkCompose=()=>{if(!composeLease)throw Error('请连接当前身份后继续这份草稿。');composeLease.assertCurrent();};
  function composeLocation(kind:'project'|'recruitment',editing:boolean,id?:string){const url=new URL(location.href);url.searchParams.set('section',kind==='project'?'projects':'recruitment');url.searchParams.delete('contactId');url.searchParams.delete('manage');url.searchParams.delete(kind==='project'?'recruitmentId':'projectId');if(editing)url.searchParams.set('compose',kind);else url.searchParams.delete('compose');const field=kind==='project'?'projectId':'recruitmentId';if(id)url.searchParams.set(field,id);else url.searchParams.delete(field);window.history.replaceState(window.history.state,'',url.pathname+url.search);window.dispatchEvent(new Event('galaxy:route-view-changed'));}
  function managementLocation(mode:'roles'|'transfer'|'read',id=project?.projectId){const url=new URL(location.href);url.searchParams.set('section','projects');url.searchParams.delete('compose');url.searchParams.delete('contactId');url.searchParams.delete('recruitmentId');if(id)url.searchParams.set('projectId',id);if(mode==='read')url.searchParams.delete('manage');else url.searchParams.set('manage',mode);setProjectMode(mode);window.history.replaceState(window.history.state,'',url.pathname+url.search);window.dispatchEvent(new Event('galaxy:route-view-changed'));}
  async function read(path: string, input?: unknown) {
    if(projectViewScope(runtime,connected)!==viewScope)throw new Error('身份或连接已改变，请重新读取。');
    const result=await runtime.api.call(path, input, {
      authenticated: connected,
      ...(input === undefined ? { method: 'GET' } : {}),
    });
    if(projectViewScope(runtime,connected)!==viewScope)throw new Error('身份或连接已改变，请重新读取。');
    return result;
  };
  function loadProjects(after?: string) {
    return read('/v2/projects/query', {limit:20,...(after?{after}:{})}).then((page:ProjectPage)=>{
      if(!composeMounted.current)return;
      setProjects(old=>after?[...old,...page.items]:page.items);setProjectNext(page.nextAfter);setProjectsLoaded(true);
    });
  }
  function loadRecruitments(after?: string) {
    return read('/v2/recruitment/query',{view:'managed',limit:20,...(after?{after}:{})}).then((page:RecruitmentPage)=>{
      if(!composeMounted.current)return;
      setRecruits(old=>after?[...old,...page.items]:page.items);setRecruitNext(page.nextAfter);setRecruitsLoaded(true);
    });
  }
  async function loadContacts(after?: string) {
    const request=++contactsRequest.current;
    try{
      if(initialContactId!==undefined&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(initialContactId))throw new Error('原联系链接中的编号无效，请从原联系或房间重新打开。');
      const page:ContactsPage = initialContactId!==undefined
        ?{items:[await read('/v2/contacts/'+initialContactId)],nextAfter:null}
        :await read('/v2/contacts/query', {direction,limit:20,...(after?{after}:{})});
      if(request!==contactsRequest.current)return;
      setContacts((old) => (after ? [...old, ...page.items] : page.items));
      setContactNext(page.nextAfter);setContactsState('ready');setContactsKey(contactContext);setError('');
    }catch(error){if(request===contactsRequest.current){setContacts([]);setContactNext(null);setContactsState('failed');setContactsKey(contactContext);}throw error;}
  }
  function editProject(value:ProjectView|null){if(!value)setNewProjectId(crypto.randomUUID());setProject(value);setProjectForm(projectFormFor(value,blankProject));setViewers('');setVisibility(value?.visibility??'Private');setProjectPreferences(null);}
  function editRecruitment(value:RecruitmentView|null){if(!value)setNewRecruitmentId(crypto.randomUUID());setRecruit(value);setRecruitProjectId(value?.projectId??project?.projectId??'');setRecruitForm(recruitmentFormFor(value,blankRecruitment));}
  function composeValue(kind:'project'|'recruitment',lane:ComposeLane):ComposeValue{
    if(lane.kind!==kind)throw Error('这份草稿的入口已变化，请重新打开。');
    const keys=Object.keys(kind==='project'?blankProject:blankRecruitment),input=lane.input;
    const changes=Object.fromEntries(keys.filter(key=>input.form[key]!==lane.base[key]).map(key=>[key,input.form[key]]));
    return lane.kind==='project'?{changes,step:lane.input.step,visibility:lane.input.visibility,viewers:lane.input.viewers}:{changes,step:lane.input.step,projectId:lane.input.projectId};
  }
  function checkedCompose(value:unknown,kind:'project'|'recruitment',targetId:string){return checkedProjectCompose(value,kind,targetId,kind==='project'?blankProject:blankRecruitment);}
  function showCompose(kind:'project'|'recruitment',lane:ComposeLane){
    if(lane.kind!==kind)throw Error('这份草稿的入口已变化，请重新打开。');
    if(lane.kind==='project'){setProjectForm(lane.input.form);setVisibility(lane.input.visibility);setViewers(lane.input.viewers);setProjectStep(lane.input.step);}
    else{setRecruitForm(lane.input.form);setRecruitProjectId(lane.input.projectId);setRecruitStep(lane.input.step);}
  }
  function rebaseCompose(kind:'project'|'recruitment',lane:ComposeLane,current:ProjectView|RecruitmentView){
    const changes=composeValue(kind,lane).changes;
    if(lane.kind==='project'&&!('recruitmentId' in current)){lane.base=projectFormFor(current,blankProject);lane.input={...lane.input,form:{...lane.base,...changes}};}
    else if(lane.kind==='recruitment'&&'recruitmentId' in current){lane.base=recruitmentFormFor(current,blankRecruitment);lane.input={...lane.input,form:{...lane.base,...changes}};}
    else throw Error('这份草稿的目标已变化，请重新打开。');
    lane.baseRevision=current.revision;showCompose(kind,lane);
  }
  function changeCompose(kind:'project',patch:Partial<Extract<ComposeLane,{kind:'project'}>['input']>,inputChange?:boolean):void;
  function changeCompose(kind:'recruitment',patch:Partial<Extract<ComposeLane,{kind:'recruitment'}>['input']>,inputChange?:boolean):void;
  function changeCompose(kind:'project'|'recruitment',patch:Partial<Extract<ComposeLane,{kind:'project'}>['input']>|Partial<Extract<ComposeLane,{kind:'recruitment'}>['input']>,inputChange=true){
    const lane=compose.current[kind];if(!lane||!lane.ready)return;
    if(lane.kind==='project'){if(patch.form&&!isProjectForm(patch.form))throw Error('项目输入已变化，请重新打开。');lane.input={...lane.input,...patch,form:patch.form??lane.input.form};}
    else{if(patch.form&&!isRecruitmentForm(patch.form))throw Error('招募输入已变化，请重新打开。');lane.input={...lane.input,...patch,form:patch.form??lane.input.form};}
    showCompose(kind,lane);if(inputChange)lane.started=true;if(!lane.started||lane.failed)return;
    const value=composeValue(kind,lane);setComposeStatus(old=>({...old,[kind]:'正在保存本机草稿…'}));
    const next=lane.queue.then(async()=>{checkCompose();const expected=lane.head;
      const saved=checkedCompose(await runtime.updateLocal(lane.key,(raw:unknown)=>{checkCompose();const current=checkedCompose(raw,kind,lane.targetId);
        if((current?.revision??null)!==expected&&!(current==null&&expected!=null&&lane.clearedRevision===expected))throw Error('另一页已修改这份草稿，当前输入仍在本页，请重新打开后核对。');
        return{version:1,targetId:lane.targetId,objectId:lane.objectId,baseRevision:lane.baseRevision,revision:crypto.randomUUID(),value,...(current?.attempt?{attempt:current.attempt}:{}),...((lane.acknowledgedId??current?.acknowledgedObjectId)?{acknowledgedObjectId:lane.acknowledgedId??current?.acknowledgedObjectId}:{})};
      },subjectId),kind,lane.targetId);checkCompose();if(!saved)throw Error('草稿暂未保存，请保留本页输入。');
      lane.head=saved.revision;lane.started=true;
      if(composeMounted.current&&compose.current[kind]===lane&&JSON.stringify(composeValue(kind,lane))===JSON.stringify(value))setComposeStatus(old=>({...old,[kind]:'草稿已保存在本机。'}));
    });
    lane.queue=next;void next.catch((reason:unknown)=>{lane.failed=true;if(composeMounted.current&&compose.current[kind]===lane)setComposeStatus(old=>({...old,[kind]:projectErrorText(reason)||'草稿暂未保存，请保留本页输入。'}));});
  }
  async function readCompose(kind:'project'|'recruitment',lane:ComposeLane){await lane.queue;checkCompose();let saved=checkedCompose(await runtime.getLocal(lane.key,subjectId),kind,lane.targetId);checkCompose();let completedId:string|null=null,acknowledgedId:string|null=saved?.acknowledgedObjectId??lane.acknowledgedId??null;
    if(saved?.attempt){const result=await client!.reviewPending(saved.attempt.operationId);checkCompose();if(result?.state==='acknowledged'){if(result.objectId!==saved.objectId)throw Error('原提交与这份草稿的目标不一致，请保留记录后重新打开。');const original=saved;let removed=false;acknowledgedId=result.objectId;lane.acknowledgedId=result.objectId;saved=checkedCompose(await runtime.updateLocal(lane.key,(raw:unknown)=>{checkCompose();const current=checkedCompose(raw,kind,lane.targetId);if(current?.revision===original.revision&&current?.attempt?.operationId===original.attempt?.operationId){if(current.revision===original.attempt?.revision&&(!lane.ready||JSON.stringify(composeValue(kind,lane))===JSON.stringify(original.value))){lane.clearedRevision=original.revision;removed=true;return null;}return{...current,attempt:undefined,acknowledgedObjectId:result.objectId};}return raw;},subjectId),kind,lane.targetId);checkCompose();if(removed){const matches=!lane.ready||JSON.stringify(composeValue(kind,lane))===JSON.stringify(original.value);if(matches)completedId=result.objectId;if(lane.head===original.revision){lane.head=null;lane.started=!matches;if(matches&&composeMounted.current&&compose.current[kind]===lane)setComposeStatus(old=>({...old,[kind]:''}));}}}}
    lane.acknowledgedId=acknowledgedId;return{saved,completedId,acknowledgedId};
  }
  function openComposer(kind:'project'|'recruitment',id?:string,currentView:()=>boolean=()=>true){checkCompose();composeLocation(kind,true,id);
    const other=kind==='project'?'recruitment':'project';if(compose.current[other])compose.current[other].open=false;
    const previous=compose.current[kind];
    return (previous?.queue.catch(()=>{})??Promise.resolve()).then(async()=>{checkCompose();if(!composeMounted.current||!currentView())return null;
    const targetId=id??'new',initial={key:kind+'-compose:v1:'+targetId,targetId,objectId:id??crypto.randomUUID(),head:null,queue:Promise.resolve(),ready:false,started:false,open:true,baseRevision:0};
    const lane:ComposeLane=kind==='project'?{...initial,kind,base:{...blankProject},input:{form:{...blankProject},step:0,visibility:'Private',viewers:''}}:{...initial,kind,base:{...blankRecruitment},input:{form:{...blankRecruitment},step:0,projectId:''}};compose.current[kind]=lane;
    return {lane,result:await readCompose(kind,lane)};
    }).then(async(prepared)=>{if(!prepared)return;const {lane,result}=prepared;checkCompose();if(!composeMounted.current||!currentView()||!lane.open||compose.current[kind]!==lane)return;
    setComposeReady(old=>({...old,[kind]:false}));setComposeStatus(old=>({...old,[kind]:'正在读取本机草稿…'}));
    if(kind==='project'){setProject(null);setProjectMode('edit');}else{setRecruit(null);setRecruitMode('edit');}
    if(result.completedId){const received=await read('/v2/'+(kind==='project'?'projects':'recruitment')+'/'+result.completedId);if(!composeMounted.current||!currentView()||!lane.open||compose.current[kind]!==lane)return;if(kind==='project'){editProject(received);setProjectMode('read');}else{editRecruitment(received);setRecruitMode('read');}lane.open=false;composeLocation(kind,false,result.completedId);setComposeStatus(old=>({...old,[kind]:''}));setMessage('上次提交已完成。');return;}
    let current:ProjectView|RecruitmentView|null=null;const currentId=id??result.acknowledgedId;if(currentId){current=await read('/v2/'+(kind==='project'?'projects':'recruitment')+'/'+currentId);checkCompose();if(kind==='project'&&(!current||'recruitmentId' in current||!current.permissions.edit))throw Error('当前不能编辑这个项目，原草稿仍保留。');if(kind==='recruitment'&&current){const represented:ProjectView=await read('/v2/projects/'+current.projectId);if(!represented.permissions?.represent||current.state==='closed')throw Error('当前不能继续编辑这项招募，原草稿仍保留。');}}
    await loadProjects();if(kind==='recruitment')await loadRecruitments();checkCompose();if(!composeMounted.current||!currentView()||!lane.open||compose.current[kind]!==lane)return;
    const saved=result.saved,changes={...saved?.value.changes};
    lane.head=saved?.revision??null;lane.objectId=saved?.objectId??lane.objectId;lane.started=!!saved;lane.baseRevision=current?.revision??0;
    if(lane.kind==='project'){
      if(current&&'recruitmentId' in current)throw Error('这份草稿的目标已变化，请重新打开。');
      if(current&&!current.permissions.manage){Reflect.deleteProperty(changes,'discoverable');Reflect.deleteProperty(changes,'participantKind');}
      lane.base=projectFormFor(current,blankProject);
      lane.input={form:{...lane.base,...changes},step:saved?.value.step??0,visibility:saved?.value.visibility??current?.visibility??'Private',viewers:saved?.value.viewers??''};
      setProject(current);setNewProjectId(lane.objectId);setProjectMode('edit');
    }else{
      if(current&&!('recruitmentId' in current))throw Error('这份草稿的目标已变化，请重新打开。');
      lane.base=recruitmentFormFor(current,blankRecruitment);
      lane.input={form:{...lane.base,...changes},step:saved?.value.step??0,projectId:saved?.value.projectId??current?.projectId??(recruitProjectEligible(project)?project!.projectId:'')};
      setRecruit(current);setNewRecruitmentId(lane.objectId);setRecruitMode('edit');
    }lane.ready=true;
showCompose(kind,lane);setComposeReady(old=>({...old,[kind]:true}));setComposeStatus(old=>({...old,[kind]:saved?(saved.baseRevision!==lane.baseRevision?'原内容已有更新，已在当前内容上恢复你改过的字段，请重新预览。':'已恢复本机草稿。'):''}));if(saved?.attempt)await settleOpenComposers();
    });
  }
  async function markCompose(kind:'project'|'recruitment',operationId:string):Promise<ComposeMarker|null>{const lane=compose.current[kind];if(!lane?.ready)return null;await lane.queue;checkCompose();const saved=checkedCompose(await runtime.getLocal(lane.key,subjectId),kind,lane.targetId);checkCompose();if(saved?.attempt){const previous=await client!.reviewPending(saved.attempt.operationId);checkCompose();if(previous?.state==='acknowledged'){await settleOpenComposers();throw Error('上次提交已完成，请基于当前内容重新预览后继续。');}if(previous)throw Error('请先从提交状态继续原操作，当前修改仍保存在草稿中。');}const revision=lane.head,value=composeValue(kind,lane);if(revision)await runtime.updateLocal(lane.key,(raw:unknown)=>{checkCompose();const current=checkedCompose(raw,kind,lane.targetId);if(current?.revision!==revision)throw Error('另一页已修改这份草稿，请重新打开后核对。');return{...current,attempt:{operationId,revision}};},subjectId);checkCompose();return{lane,revision,value};}
  async function settleOpenComposers(){for(const kind of ['project','recruitment'] as const){const lane=compose.current[kind];if(!lane?.head)continue;const result=await readCompose(kind,lane);if((result.completedId||result.acknowledgedId)&&lane.open&&compose.current[kind]===lane){const current=await read('/v2/'+(kind==='project'?'projects':'recruitment')+'/'+(result.completedId??result.acknowledgedId));checkCompose();if(!composeMounted.current||!lane.open||compose.current[kind]!==lane)continue;if(result.completedId){if(kind==='project'){editProject(current);setProjectMode('read');}else{editRecruitment(current);setRecruitMode('read');}lane.open=false;composeLocation(kind,false,result.completedId);}else{if(kind==='project')setProject(current);else setRecruit(current);rebaseCompose(kind,lane,current);}}}}
  function leaveComposer(kind:'project'|'recruitment',id?:string){if(compose.current[kind])compose.current[kind].open=false;composeLocation(kind,false,id);setConfirmation(null);}
  const names=useMemberNames(runtime,subjectId??undefined,connected,[...audienceIds,...tags(viewers),...contacts.flatMap(item=>[item.initiatorId,item.recipientId]),...opportunities.map(item=>item.subjectId),...(project?.management?.roles??[]).map(item=>item.subjectId),...(project?.management?.transfers??[]).flatMap(item=>[item.fromSubjectId,item.toSubjectId]),...(pendingReview?[projectErrorText(pendingReview.payload,'recipientId'),projectErrorText(pendingReview.payload,'subjectId'),projectErrorText(pendingReview.payload,'toSubjectId'),...(pendingReview.viewers??[])].filter(Boolean):[])]);
  const name=(id:string)=>names[id]??memberName(id);
  useEffect(()=>{if(confirmation)previewDialog.current?.showModal();else previewDialog.current?.close();},[confirmation]);
  useEffect(()=>{if(contactReply)contactDialog.current?.showModal();else contactDialog.current?.close();},[contactReply]);
  useEffect(()=>{if(detailOpen&&detail)detailDialog.current?.showModal();else detailDialog.current?.close();},[detailOpen,detail]);
  useEffect(()=>{if(pendingReview)pendingDialog.current?.showModal();else pendingDialog.current?.close();},[pendingReview]);
  async function refreshVisible(){if(tab==='projects'){await loadProjects();if(project&&['read','roles','transfer'].includes(projectMode))editProject(await read('/v2/projects/'+project.projectId));}else if(tab==='recruitment'){await loadRecruitments();if(recruit&&recruitMode==='read')setRecruit(await read('/v2/recruitment/'+recruit.recruitmentId));}else if(tab==='contacts')await loadContacts();}
  const recoverPending=useEffectEvent(async(current:()=>boolean)=>{
    if(!client)return;let completed=false;const reasons:Record<string,string>={};
    const value=await client.pending();
    for(const item of value){if(!current()||working.current)return;try{const result=await client.resumePending(item.operationId);if(result.state==='acknowledged')completed=true;else if(operationWaitText(result))reasons[item.operationId]=operationWaitText(result);else if(result.reason==='authorization-review-required')reasons[item.operationId]='请确认原内容后继续。';else if(result.state==='stopped-local')reasons[item.operationId]='已停止本机发送。';}catch{reasons[item.operationId]='暂未确认，系统会继续核对。';}}
    const remaining=await client.pending();if(current()&&!working.current){setPending(remaining);setPendingNotes(reasons);await settleOpenComposers();if(!current())return;if(completed){setPendingReview(old=>old&&!remaining.some(item=>item.operationId===old.operationId)?null:old);setMessage('上次提交已完成。');await refreshVisible();}}
  });
  useEffect(()=>{
    let active=true,reading=false;
    const refresh=()=>{if(!active||document.visibilityState!=='visible'||!writable||working.current||reading)return;reading=true;void recoverPending(()=>active).catch(()=>{}).finally(()=>{reading=false;});};
    refresh();const timer=window.setInterval(refresh,20000);document.addEventListener('visibilitychange',refresh);
    return()=>{active=false;window.clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};
  },[writable,viewScope]);
  useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),20000);return()=>window.clearInterval(timer);},[]);
  async function run(fn: () => Promise<unknown>) {
    if (working.current) return;
    working.current=true;
    projectReadEpoch.current++;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await fn();
    } catch (e: unknown) {
      const code=projectErrorText(e,'code')||projectErrorText(e);
      if(projectErrorFlag(e,"originalOperationRetained")&&projectErrorText(e,"operationId")&&operationWaitText(e)){const original=await client!.reviewPending(projectErrorText(e,"operationId"));if(original?.payload){setConfirmation(null);setPendingReview(original);}setError(operationWaitText(original??e));return;}
      if(code==='community_quota_exceeded'){
        let quota:Quota|null=null;try{const status:{quotas:Quota[]}=await runtime.accounts.quotas();checkCompose();quota=status.quotas.find(item=>item.category===(tab==='recruitment'?'task':'invitation'))??null;if(tab==='recruitment')setPublicationQuota(quota??null);}catch{}
        setError((tab==='recruitment'?'今天可公开发布的求助和招募次数已用完。':'今天这类公开操作的次数已用完。')+'内容仍保存在本机，'+(quota?.resetAt?'可在 '+readableTime(quota.resetAt)+' 后继续。':'请在次数恢复后继续。'));
        return;
      }
      setError(
        projectErrorFlag(e,"resultUnknown")
          ? '上次操作暂未确认，内容已保留。请从提交状态继续。'
          : projectErrorText(e,'name')==='ZodError'?'请补全必要内容，并核对名称、说明、身份与有效时间。':({account_verification_required:'发布前需要完成账号验证，当前内容仍保留。',recruitment_project_unavailable:'原项目当前不能用于发布招募，请选择公开且进行中的项目。',project_source_unavailable:'原项目介绍当前不能完整公开读取，请先检查项目的分享范围。',project_not_found:'原项目当前不可读取，请重新选择可公开阅读的项目。',recruitment_public_consent_required:'这项招募需要你确认公开发布，请返回预览核对。',invitation_cooldown:'最近发出的联系还在等待对方回应，请保留原内容，稍后再联系。',community_restricted:'当前账号暂时不能进行这类公开操作，内容仍保留；请在账号设置中查看当前限制。'} as Record<string,string>)[code]??projectErrorText(e),
      );
    } finally {
      if (writable)
        try {
          setPending(await client!.pending());
        } catch {}
      working.current=false;
      setBusy(false);
    }
  }
  useEffect(()=>{if(projectViewScope(runtime,connected)===viewScope)projectQueryMemory(runtime,connected,'contact-list',{query,note,roomTitle});},[runtime,viewScope,connected,query,note,roomTitle]);
  async function loadAudience(after?:string){checkCompose();try{const page:ContactsPage=await read('/v2/contacts/query',{direction:'both',limit:50,...(after?{after}:{})});checkCompose();if(!composeMounted.current)return;const ids:string[]=page.items.map(item=>item.initiatorId===subjectId?item.recipientId:item.initiatorId).filter((id:unknown)=>typeof id==='string');setAudienceIds(old=>[...new Set<string>(after?[...old,...ids]:ids)]);setAudienceAfter(page.nextAfter??null);setAudienceLoaded(true);setAudienceError('');}catch(error){if(composeMounted.current){setAudienceLoaded(true);setAudienceError('联系人暂未读取成功，可以重新读取。');}throw error;}}
  const refreshAudience=useEffectEvent(()=>{void loadAudience().catch(()=>{});});
  useEffect(()=>{if(projectMode==='edit'&&projectStep===1&&visibility==='Private'&&composeReady.project&&!audienceLoaded)refreshAudience();},[projectMode,projectStep,visibility,composeReady.project,audienceLoaded]);
  const readRecruitProject=useEffectEvent((id:string,currentView:()=>boolean)=>read('/v2/projects/'+id).then(async(current:ProjectView)=>{
    checkCompose();if(currentView())setProjects(old=>[...old.filter(item=>item.projectId!==id),current]);
    if(!recruitProjectEligible(current))throw Error('这项招募需要公开且进行中的项目，以及你当前的对外代表权限。请先调整原项目，或选择其他可发布的项目。');
    const publicView:ProjectView=await runtime.api.call('/v2/projects/'+id,undefined,{method:'GET',authenticated:false});checkCompose();
    if(publicView.projectId!==id||!publicView.document)throw Error('原项目介绍当前不能完整公开读取，请先检查它的分享范围。');
    if(currentView())setRecruitProjectCheck({id,state:'ready'});
  }));
  useEffect(()=>{if(recruitMode!=='edit'||!composeReady.recruitment||!recruitProjectId)return;let active=true;const id=recruitProjectId;
    void readRecruitProject(id,()=>active).catch((error:unknown)=>{if(active)setRecruitProjectCheck({id,state:'failed',message:projectErrorText(error,'code')?'原项目介绍当前不能完整公开读取，请检查分享范围和当前代表权限。':projectErrorText(error)||'原项目暂未读取成功，请重试。'});});
    return()=>{active=false;};
  },[viewScope,recruitMode,recruitProjectId,composeReady.recruitment,recruitProjectRead]);
  const readQuota=useEffectEvent((current:()=>boolean)=>runtime.accounts.quotas().then((value:{quotas:Quota[]})=>{checkCompose();if(current())setPublicationQuota(value.quotas.find(item=>item.category==='task')??null);}));
  useEffect(()=>{if(recruitMode!=='edit'||recruitStep!==1||!composeReady.recruitment)return;let active=true;void readQuota(()=>active).catch(()=>{});return()=>{active=false;};},[recruitMode,recruitStep,composeReady.recruitment]);
  const requestedCompose=new URLSearchParams(location.search).get('compose'),initialRecruitmentId=new URLSearchParams(location.search).get('recruitmentId'),requestedManagement=new URLSearchParams(location.search).get('manage');
  const readRequested=useEffectEvent((currentView:()=>boolean)=>{
    if(writable&&(requestedCompose==='project'||requestedCompose==='recruitment')){const id=requestedCompose==='project'?initialProjectId:initialRecruitmentId??undefined,lane=compose.current[requestedCompose];if(!lane?.open||lane.targetId!==(id??'new'))return openComposer(requestedCompose,id,currentView);}
    else if(initialTab==='recruitment'&&initialRecruitmentId&&/^[0-9a-f-]{36}$/.test(initialRecruitmentId))return read('/v2/recruitment/'+initialRecruitmentId).then((value:RecruitmentView)=>{if(currentView()){editRecruitment(value);setRecruitMode('read');}});
    else if(initialProjectId&&/^[0-9a-f-]{36}$/.test(initialProjectId))return read('/v2/projects/'+initialProjectId).then((value:ProjectView)=>{if(currentView()){editProject(value);setProjects([value]);setProjectMode(value.permissions.manage&&(requestedManagement==='roles'||requestedManagement==='transfer')?requestedManagement:'read');if(requestedManagement&&!value.permissions.manage)setError('当前身份已不能管理这个项目，原来未提交的选择仍保留在本机。');}}).catch(error=>{if(currentView())editProject(null);throw error;});
    return Promise.resolve();
  });
  useEffect(()=>{let active=true;void readRequested(()=>active).catch((error:unknown)=>{if(active)setError(projectErrorText(error).trim()?projectErrorText(error):initialTab==='recruitment'?'招募详情暂未读取成功，请重新打开。':'项目详情暂未读取成功，请重新打开或刷新。');});return()=>{active=false;};},[viewScope,initialTab,initialProjectId,initialRecruitmentId,requestedCompose,requestedManagement,writable]);
  const refreshContacts=useEffectEvent(async()=>loadContacts());
  useEffect(()=>{
    let active=true,reading=false;const requestRef=contactsRequest;
    if(tab!=='contacts'||!writable)return;

    const refresh=()=>{if(!active||reading||working.current||document.visibilityState!=='visible')return;reading=true;
      void refreshContacts().catch(e=>{if(active)setError(projectErrorText(e).trim()?projectErrorText(e):'联系列表暂未读取成功，请重试。');}).finally(()=>{reading=false;});};
    refresh();const timer=window.setInterval(refresh,20000);document.addEventListener('visibilitychange',refresh);
    return()=>{active=false;requestRef.current++;window.clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};
  },[runtime,viewScope,tab,direction,writable,initialContactId]);
  async function projectWrite(event:ProjectChoice,extraViewers:string[]=[],selection:ProjectSelection|null=null) {
    const targetId=event.projectId??project?.projectId??newProjectId,expectedRevision=event.expectedRevision??project?.revision??0;
    const managing=['grant-role','revoke-role','offer-transfer','accept-transfer','cancel-transfer'].includes(event.kind);
    let selectedVisibility=visibility;
    if(managing){
      const previous=(await client!.pending()).find(item=>item.type==='project'&&item.objectId===targetId);checkCompose();
      if(previous){await reviewManagementOperation(previous.operationId);return false;}
      const current:ProjectView=await read('/v2/projects/'+targetId);checkCompose();
      if(current.projectId!==targetId)throw Error('当前项目暂时无法准确核对，请重新读取。');
      if(project?.projectId===targetId)setProject(current);
      if(event.kind==='accept-transfer'){
        if(!current.document||!current.management?.transfers?.some(item=>item.transferId===event.transferId&&item.toSubjectId===subjectId&&item.state==='offered'))throw Error('这次转交已变化，或原项目介绍当前不可读，请重新核对。');
      }else if(!current.permissions?.manage){managementLocation('read',targetId);throw Error('当前身份已不能管理这个项目，未提交的选择仍保留。');}
      if(current.state!=='active'&&event.kind!=='cancel-transfer')throw Error('这个项目已归档，请恢复项目后再调整管理关系。');
      if(current.revision!==expectedRevision)throw Error('项目刚刚有更新，已重新读取。请核对当前项目与角色后再继续。');
      selectedVisibility=current.visibility;
    }
    const operationId=crypto.randomUUID(),marker=projectMode==='edit'&&['create','revise'].includes(event.kind)?await markCompose('project',operationId):null;
    if(selection)await selection.draft.attach({kind:'project-management',operationId,projectId:targetId,action:event.kind,person:'subjectId' in event?event.subjectId:'toSubjectId' in event?event.toSubjectId:undefined,...('role' in event?{role:event.role}:{})},selection.revision);
    const receipt = await client!.submit(
      'project',
      {
        projectId: targetId,
        expectedRevision,
        ...event,
        operationId,
      },
      {
        visibility:selectedVisibility,
        viewers: managing?extraViewers:[...tags(viewers), ...extraViewers],
        confirmed: true,
      },
    );
    if(selection)await selection.draft.settle(locator=>projectSelectionReceipt(client!,targetId,locator));
    setMessage(({'create':'项目已保存。','revise':'项目已保存。','archive':'项目已归档。','restore':'项目已恢复。','grant-role':'协作权限已更新。','revoke-role':'协作权限已更新。','offer-transfer':'管理转交邀请已发出。','cancel-transfer':'管理转交邀请已取消。','accept-transfer':'已接受项目管理转交。'} as Record<string,string>)[event.kind]??'项目设置已更新。');
    if(marker)marker.lane.acknowledgedId=receipt.projectId;
    const settled=marker?await readCompose('project',marker.lane):null;
    const finish=!marker||(compose.current.project===marker.lane&&marker.lane.open&&!settled?.saved&&JSON.stringify(composeValue('project',marker.lane))===JSON.stringify(marker.value));
    try{await loadProjects();}catch(error:unknown){if(selection&&error instanceof Error)Object.assign(error,{operationAcknowledged:true});throw error;}
    try {
      const current:ProjectView=await read('/v2/projects/' + receipt.projectId);
      if(finish)editProject(current);else if(marker&&compose.current.project===marker.lane&&marker.lane.open){setProject(current);rebaseCompose('project',marker.lane,current);}
    } catch {
      if(finish)editProject(null);
      setMessage(
        '这次项目更新已完成；当前身份暂时不能读取完整介绍。',
      );
    }
    if(marker&&finish)leaveComposer('project',receipt.projectId);else if(marker)setMessage('上次项目内容已接收，你之后改动的草稿仍保留。');
    return finish;
  }
  async function reviewManagementOperation(operationId:string){const value=await client!.reviewPending(operationId);checkCompose();if(value?.payload)setPendingReview(value);else if(value?.state==='acknowledged'){setMessage('上次项目操作已完成。');await refreshVisible();}else setMessage('这次原操作当前没有保留的待确认记录，未提交的选择仍保留。');}
  async function saveProject() {
    const document = {
      ...projectForm,
      functions: tags(projectForm.functions),
      technologies: tags(projectForm.technologies),
    };
    if (!document.sourceUrl) delete document.sourceUrl;
    if (!project) return projectWrite({ kind: 'create', document });
    else {
      const patch:Partial<Omit<typeof document,'sourceUrl'>>&{sourceUrl?:string|null} = { ...document };
      if (!projectForm.sourceUrl) patch.sourceUrl = null;
      if (!project.permissions.manage) {
        delete patch.discoverable;
        delete patch.participantKind;
      }
      return projectWrite({ kind: 'revise', patch });
    }
  }
  async function recruitWrite(kind:import('./project-workspace-types').RecruitmentEvent['kind'],extra:{note?:string;taskId?:string;expectedTaskVersion?:number}={}) {
    const operationId=crypto.randomUUID(),marker=recruitMode==='edit'&&['create','revise','renew'].includes(kind)?await markCompose('recruitment',operationId):null;
    const id = recruit?.recruitmentId ?? newRecruitmentId;
    let event:unknown = {
      kind,
      recruitmentId: id,
      projectId: recruit?.projectId ?? recruitProjectId,
      expectedRevision: recruit?.revision ?? 0,
      ...extra,
      operationId,
    };
    if (['create', 'revise', 'renew'].includes(kind)) {
      const { days, ...fields } = recruitForm;
      event = {
        ...(object(event)?event:{}),
        document: {
          ...fields,
          functions: tags(fields.functions),
          technologies: tags(fields.technologies),
          contactSubjectId: subjectId,
        },
        expiresAt: recruitmentExpiry(days),
      };
    }
    await client!.submit('recruitment', event, {
      visibility: ['create', 'revise', 'renew'].includes(kind)
        ? 'Public'
        : 'Private',
      confirmed: true,
    });
    setMessage(({'create':'招募已发布。','revise':'招募已保存。','renew':'招募已续期。','pause':'招募已暂停。','close':'招募已关闭。','link-task':'已关联这项求助。'} as Record<string,string>)[kind]??'招募已更新。');
    if(marker)marker.lane.acknowledgedId=id;
    const settled=marker?await readCompose('recruitment',marker.lane):null;
    const finish=!marker||(compose.current.recruitment===marker.lane&&marker.lane.open&&!settled?.saved&&JSON.stringify(composeValue('recruitment',marker.lane))===JSON.stringify(marker.value));
    await loadRecruitments();
    // An owner may close a source that is no longer publicly readable. The write receipt is still valid.
    try {
      const current:RecruitmentView=await read('/v2/recruitment/' + id);if(finish)editRecruitment(current);else if(marker&&compose.current.recruitment===marker.lane&&marker.lane.open){setRecruit(current);rebaseCompose('recruitment',marker.lane,current);}
    } catch {
      if(finish)setRecruit(null);
    }
    if(marker&&finish)leaveComposer('recruitment',id);else if(marker)setMessage('上次招募内容已接收，你之后改动的草稿仍保留。');
    return finish;
  }
  async function search(after?: string) {
    const request:DiscoveryQuery|null = after
      ? submitted
      : {
          context: {
            kind: 'ephemeral',
            title: query.title,
            functions: tags(query.functions),
            technologies: tags(query.technologies),
          },
          purposes: [query.purpose],
        };
    if(!request)throw Error('请先读取当前查找范围。');
    const page:import('./project-workspace-types').DiscoveryPage = await read('/v2/discovery/query', {
      ...request,
      limit: 20,
      ...(after ? { after } : {}),
    });
    setSubmitted(request);
    setOpportunities((old) => (after ? [...old, ...page.items] : page.items));
    setQueryNext(page.nextAfter);
    setSearched(true);
    if (!after) {
      setSelected([]);
      setDetail(null);
      setSendResults([]);
      setSourceDenied(false);
    }
  }
  function chooseTab(next:string){setTab(next);for(const lane of Object.values(compose.current))if(lane)lane.open=false;setProjectMode('list');setRecruitMode('list');const url=new URL(location.href);url.searchParams.set('section',next);url.searchParams.delete('compose');url.searchParams.delete('manage');url.searchParams.delete('projectId');url.searchParams.delete('recruitmentId');if(next!=='contacts')url.searchParams.delete('contactId');window.history.replaceState(window.history.state,'',url.pathname+url.search);window.dispatchEvent(new Event('galaxy:route-view-changed'));}
  function loadPreferences(){return read('/v1/discovery/preferences/read',{}).then(async(global:PreferencesView)=>{if(!composeMounted.current)return;setDiscoveryPreferences(global);if(project?.document){const selected:ProjectPreferencesView=await read('/v2/projects/'+project.projectId+'/preferences/read',{});if(composeMounted.current)setProjectPreferences(selected);}});}
  async function savePreferences(patch:Partial<PreferencesView['preferences']>){if(!discoveryPreferences)throw Error('请先读取当前交流意愿。');setDiscoveryPreferences(await read('/v1/discovery/preferences/save',{expectedRevision:discoveryPreferences.revision,preferences:{...discoveryPreferences.preferences,...patch}}));setMessage('交流意愿已更新。');}
  async function loadTasks(after?:string){const page=await read('/v2/tasks/query',{view:'requested',limit:20,...(after?{after}:{})});setTasks(old=>after?[...old,...page.items]:page.items);setTaskNext(page.nextAfter??page.next??null);}
  const loadTab=useEffectEvent(()=>{if(working.current)return;const loaded=tab==='projects'?loadProjects():tab==='recruitment'?loadProjects().then(()=>loadRecruitments()):tab==='willingness'?loadPreferences():Promise.resolve();void loaded.catch((error:unknown)=>{if(composeMounted.current)setError(projectErrorText(error)||'当前内容暂未读到，请稍后再试。');});});
  useEffect(()=>{if(writable)loadTab();},[tab,writable]);
  function confirmAction(title:string,body:React.ReactNode,execute:()=>Promise<unknown>){setConfirmation({title,body,execute});}

  const readManagedProject=useEffectEvent(async(id:string,epoch:number,current:()=>boolean)=>{try{const value:ProjectView=await read('/v2/projects/'+id);if(!current()||working.current||epoch!==projectReadEpoch.current)return;if(value.projectId!==id)throw Error('项目的读取结果不匹配，请重新打开。');setProject(value);if(['roles','transfer'].includes(projectMode)&&!value.permissions.manage){managementLocation('read',id);setMessage('项目管理关系已变化，未提交的选择仍保留在本机。');}}catch(reason){if(current()&&!working.current&&epoch===projectReadEpoch.current){if([403,404].includes(projectErrorNumber(reason)??0)){setProject(null);setProjectMode('list');setConfirmation(null);void loadProjects().catch(()=>{});setError('原项目当前不可读取，未提交的编辑稿和选人草稿仍保留在本机。');}else setError('项目当前状态暂未重新读取，请稍后再试。');}}});
  useEffect(()=>{
    if(tab!=='projects'||!writable||!project?.projectId||!['read','roles','transfer'].includes(projectMode))return;
    let active=true,reading=false;const id=project.projectId,epochRef=projectReadEpoch;
    const refresh=()=>{if(!active||reading||working.current||document.hidden)return;reading=true;const epoch=projectReadEpoch.current;
      void readManagedProject(id,epoch,()=>active).finally(()=>{reading=false;});
    };
    const timer=window.setInterval(refresh,20000);document.addEventListener('visibilitychange',refresh);
    return()=>{active=false;epochRef.current++;window.clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};
  },[runtime,viewScope,tab,writable,project?.projectId,projectMode]);
  function hideSource(item:VisibleOpportunity){setOpportunities(old=>old.map(row=>row.id===item.id?{...opportunityLocator(row),sourceUnavailable:true as const}:row));setDetail(old=>old?.opportunity.id===item.id?null:old);setSelected(old=>old.filter(id=>id!==item.id));setSourceDenied(true);}
  async function inspect(item:Opportunity,after?:string|null) {
    if(!submitted)throw Error('请先读取当前查找范围。');
    try{setDetail(await read('/v2/discovery/detail', {
        ...submitted,
        opportunityRef: item.opportunityRef,
        ...(after ? { experienceAfter: after } : {}),
      }));}catch(error){if(opportunityUnavailable(error))hideSource(item);throw error;}
  }
  async function sendSelected() {
    if(!submitted)throw Error('请先读取当前查找范围。');
    if (!note.trim()) throw new Error('请填写准备分别发送的说明。');
    const results:SendResult[] = [];
    for (const item of opportunities.filter((x):x is Opportunity => selected.includes(x.id)&&!x.sourceUnavailable)) {
      try {
        const result = await viewClient!.send(submitted,item,{purpose:submitted.purposes[0],note,roomTitle});
        results.push({ id: item.id, subjectId: item.subjectId, result });
      } catch (e: unknown) {
        if(projectErrorFlag(e,"sourceUnavailable"))hideSource(item);
        results.push({
          id: item.id,
          subjectId: item.subjectId,
          error: projectErrorFlag(e,"sourceUnavailable")?'当前资料或联系意愿已变化，请重新查询。':projectErrorText(e),
          unknown: !!projectErrorFlag(e,"resultUnknown"),
          operationId: projectErrorText(e,'operationId'),
        });
      }
      setSendResults([...results]);
    }
    setSelected([]);
    await loadContacts();
  }
  async function respond(contact:ContactView,kind:Exclude<ContactEvent['kind'],'send'>) {
    let result;
    try { result = await client!.submit(
      'contact',
      {
        kind,
        contactId: contact.contactId,
        expectedRevision: contact.revision,
        note: responseNotes[contact.contactId] ?? '',
      },
      { viewers: [contact.initiatorId, contact.recipientId], confirmed: true },
    ); } catch(error:unknown) {
      if([403,404].includes((projectErrorNumber(error)??0))){
        // The rejected action is evidence that the old view may no longer be
        // readable. Remove source bodies before waiting on a fresh read.
        setContacts(rows=>rows.map(row=>row.contactId===contact.contactId?{...row,sourceNeedsRefresh:true,
          events:row.events.map(event=>({operationId:event.operationId,subjectId:event.subjectId,kind:event.kind,revision:event.revision,recordedAt:event.recordedAt,contentUnavailable:true}))}:row));
        try{await loadContacts();}catch{}
        if(['consent_required','contact_source_unavailable','contact_willingness_unavailable','contact_not_found'].includes(projectErrorText(error,"code"))&&error instanceof Error)error.message='这次回应未被接受。旧资料已隐藏，请以重新读取后的联系状态为准。';
      }
      throw error;
    }
    setMessage(stateNames[result.state] ?? result.state);
    await loadContacts();
    return result;
  }
  const changeProjectForm=(form:ProjectForm)=>changeCompose('project',{form}),changeRecruitForm=(form:RecruitmentForm)=>changeCompose('recruitment',{form});
  const projectComposePending=pending.some(item=>item.type==='project'&&item.objectId===(project?.projectId??newProjectId)),recruitComposePending=pending.some(item=>item.type==='recruitment'&&item.objectId===(recruit?.recruitmentId??newRecruitmentId));
  const audienceChoices=[...new Set<string>([...audienceIds,...(project?.management?.roles??[]).map(item=>item.subjectId),...tags(viewers)])].filter(id=>id!==subjectId);
  const recruitmentProjects=projects.filter(recruitProjectEligible),recruitmentSourceReady=recruitProjectCheck.id===recruitProjectId&&recruitProjectCheck.state==='ready';
  const publicationLimited=publicationQuota?.remaining===0&&typeof publicationQuota.resetAt==='string'&&Date.parse(publicationQuota.resetAt)>now;
  const managingPeople=tab==='projects'&&['roles','transfer'].includes(projectMode)&&!!project?.permissions.manage;
  return <section className={'project-contact-page'+(managingPeople?' project-management-page':'')}>
    {!managingPeople&&<header className="directory-heading"><div><h1 className="small">项目与联系</h1><p className="lead">介绍正在做的事，回应交流，寻找愿意一起参与的人。</p></div><button className="text-link" onClick={()=>navigate('/app/projects')}>浏览公开项目 </button></header>}
    <nav className="workspace-tabs" aria-label="项目与联系">{[['projects','我的项目'],['contacts','联系与回应'],['recruitment','持续招募'],['willingness','交流意愿'],['discover','寻找同行']].map(([id,label])=><button key={id} aria-current={tab===id?'page':undefined} onClick={()=>chooseTab(id)}>{label}</button>)}</nav>
    {!connected&&<div className="browse-note"><p>公开内容可以直接阅读；登录后管理自己的项目和联系。</p><Button onClick={()=>navigate('/app/settings/identity')}>连接身份</Button></div>}
    {error&&<p className="message error" role="alert">{error}</p>}{message&&<p className="message"><output>{message}</output></p>}
    {pending.length>0&&<section className="operation-status"><p>有 {pending.length} 项提交尚待确认，原内容已保留。</p>{pending.map(item=><div key={item.operationId}><p>{{project:'项目',contact:'联系',recruitment:'招募'}[item.type as string]??'这项'}：{pendingNotes[item.operationId]??(operationWaitText(item)||'正在核对上次提交。')}</p><Button variant="outline" disabled={busy} onClick={()=>run(async()=>{const value=await client!.reviewPending(item.operationId);if(value?.payload)setPendingReview(value);else if(value?.state==='acknowledged'){setMessage('上次提交已完成。');await settleOpenComposers();await refreshVisible();}else setMessage('当前没有读到这次提交的记录。');})}>查看这次提交</Button></div>)}</section>}
    {tab==='projects'&&<>
      {projectMode==='list'?<>
        <div className="section-heading"><p>介绍你的作品、项目或可复用模块，也可以分享尚未完成的创作。</p><Button disabled={!writable||busy} onClick={()=>run(()=>openComposer('project'))}>添加作品或项目</Button></div>
        <div className="reading-list">{projects.map(item=><article className="reading-list-item project-list-row" key={item.projectId}><button className="reading-title-link" onClick={()=>{leaveComposer('project',item.projectId);editProject(item);setProjectMode('read');}}>{item.document?.title??'待接受的项目转交'}</button><p className="reading-prose">{item.document?.summary??'原作者尚未分享项目介绍。'}</p><p className="record-meta">{item.state==='active'?'资料已保存':'已归档'} · {item.ownRoles.map((role:string)=>({owner:'管理者',editor:'资料编辑',representative:'对外代表'}[role]??role)).join('、')||'等待你接受转交'}</p></article>)}</div>
        {projectsLoaded&&!projects.length&&<p className="empty-state">还没有你管理或参与维护的项目。</p>}{!projectsLoaded&&writable&&<p><output>正在读取项目…</output></p>}
        {projectNext&&<Button variant="outline" disabled={busy} onClick={()=>run(()=>loadProjects(projectNext))}>更多项目</Button>}
      </>:<>
        {managingPeople?<header className="project-management-heading"><button className="back-link" onClick={()=>managementLocation('read')}> 返回项目</button><h1>{projectMode==='roles'?'协作权限':'转交项目管理'}</h1><p>{project.document?.title??'当前项目'}</p></header>:<button className="back-link" onClick={()=>{leaveComposer('project');setProjectMode('list');}}> 回到我的项目</button>}
        {projectMode==='read'&&project&&<article className="project-reading">
          <h2>{project.document?.title??'待接受的项目转交'}</h2><p className="record-meta">{project.document?.kind==='module'?'模块':'作品 / 项目'} · {project.visibility==='Public'?'公开介绍':'按所选范围分享'}{project.state==='archived'?' · 已归档':''}</p>
          {project.document?<><p className="reading-prose">{project.document.summary}</p><h3>内容与涉及方向</h3><p>{project.document.functions.join('、')}</p>{project.document.technologies.length>0&&<><h3>使用的工具与技术</h3><p>{project.document.technologies.join('、')}</p></>}{project.document.sourceUrl&&<p><a href={project.document.sourceUrl} target="_blank" rel="noreferrer">查看作品来源 </a></p>}</>:<p>接受转交前，需要原管理者分享必要的项目资料。</p>}
          <div className="button-row">{project.permissions.edit&&<Button disabled={busy} onClick={()=>run(()=>openComposer('project',project.projectId))}>编辑介绍</Button>}<Button variant="outline" onClick={()=>navigate('/app/projects/'+project.projectId)}>查看项目页面</Button>{project.permissions.manage&&<><Button variant="outline" onClick={()=>managementLocation('roles')}>协作权限</Button><Button variant="outline" onClick={()=>run(async()=>{await loadPreferences();setProjectMode('preferences');})}>发现与联系设置</Button></>}</div>
          {(project.management?.transfers??[]).map((transfer)=><section className="operation-status" key={transfer.transferId}><h3>项目管理转交</h3><p>{name(transfer.fromSubjectId)} 邀请 {name(transfer.toSubjectId)} 接手管理。</p>{transfer.toSubjectId===subjectId?<Button disabled={busy||!writable||!project.document||projectComposePending} onClick={()=>confirmAction('接受项目管理',<p>你将接手 {project.document?.title} 的管理。项目已有资料、其他成员角色和工作记录继续保留。</p>,()=>projectWrite({kind:'accept-transfer',transferId:transfer.transferId},[transfer.fromSubjectId]))}>查看并接受</Button>:project.permissions.manage&&<Button variant="outline" disabled={busy||projectComposePending} onClick={()=>confirmAction('取消管理转交',<p>取消邀请 {name(transfer.toSubjectId)} 接手 {project.document?.title}。</p>,()=>projectWrite({kind:'cancel-transfer',transferId:transfer.transferId},[transfer.toSubjectId]))}>取消这次转交邀请</Button>}</section>)}
          {project.permissions.manage&&<ReadingDetails className="project-manage-more"><ReadingSummary>更多管理</ReadingSummary><div className="button-row"><button className="text-link" onClick={()=>managementLocation('transfer')}>转交项目管理</button><button className="text-link" disabled={busy} onClick={()=>confirmAction(project.state==='active'?'归档项目':'恢复项目',<p>{project.state==='active'?'将这份项目资料归档，停止参与新的发现。':'恢复这份项目资料，继续按原来的公开范围和联系设置展示。'}</p>,()=>projectWrite({kind:project.state==='active'?'archive':'restore'}))}>{project.state==='active'?'归档项目':'恢复项目'}</button></div></ReadingDetails>}
          <ReadingDetails className="technical-details"><ReadingSummary>项目的准确引用</ReadingSummary><p>{project.projectId} · 第 {project.revision} 版</p></ReadingDetails>
        </article>}
        {projectMode==='edit'&&(!project||project.permissions.edit)&&<section className="project-editor">{!composeReady.project?<><p><output>{busy?'正在读取项目和本机草稿…':'草稿尚未打开。'}</output></p><Button variant="outline" disabled={busy} onClick={()=>run(()=>openComposer('project',compose.current.project?.targetId==='new'?undefined:compose.current.project?.targetId))}>重新打开草稿</Button></>:<>
          <nav className="flow-steps" aria-label="项目编辑步骤"><button aria-current={projectStep===0?'step':undefined} onClick={()=>changeCompose('project',{step:0},false)}>1. 项目介绍</button><button aria-current={projectStep===1?'step':undefined} onClick={()=>{if(projectForm.title.trim()&&projectForm.summary.trim()&&tags(projectForm.functions).length)changeCompose('project',{step:1},false);}}>2. 分享范围</button></nav>
          <form className="workspace-form" onSubmit={event=>{event.preventDefault();if(projectStep===0){changeCompose('project',{step:1},false);return;}confirmAction(project?'保存项目介绍':'添加项目',<><h3>{projectForm.title}</h3><p className="reading-prose">{projectForm.summary}</p><p>方向：{projectForm.functions}</p>{projectForm.technologies&&<p>工具与技术：{projectForm.technologies}</p>}{projectForm.sourceUrl&&<p>来源：{projectForm.sourceUrl}</p>}<p>{visibility==='Public'?'公开分享':'仅自己'+(tags(viewers).length?'与 '+tags(viewers).map(name).join('、'):'')}</p><p>{projectForm.discoverable?'允许参与发现，仍遵循你的交流意愿设置。':'暂不参与发现。'}</p></>,async()=>{if(await saveProject())setProjectMode('read');});}}>
            <h2>{project?'编辑作品介绍':'介绍你的作品或项目'}</h2>{composeStatus.project&&<p className="record-meta"><output>{composeStatus.project}</output></p>}
            {projectStep===0?<><label>类别<select value={projectForm.kind} onChange={event=>changeProjectForm({...projectForm,kind:event.target.value})}><option value="project">作品或项目</option><option value="module">可复用模块</option></select></label><ProjectTextField label="名称" value={projectForm.title??''} disabled={busy||!composeReady.project} required={true} maxLength={120} onChange={value=>changeProjectForm({...projectForm,title:value})}/><ProjectTextField label="作品介绍与当前进展" value={projectForm.summary??''} disabled={busy||!composeReady.project} required={true} maxLength={2000} multiline onChange={value=>changeProjectForm({...projectForm,summary:value})}/><ProjectTextField label="内容与涉及方向（逗号分隔）" value={projectForm.functions??''} disabled={busy||!composeReady.project} required={true} maxLength={2000} onChange={value=>changeProjectForm({...projectForm,functions:value})}/><ProjectTextField label="使用的工具与技术（可选）" value={projectForm.technologies??''} disabled={busy||!composeReady.project} required={false} maxLength={2000} onChange={value=>changeProjectForm({...projectForm,technologies:value})}/><ProjectTextField label="HTTPS 作品来源（可选）" value={projectForm.sourceUrl??''} disabled={busy||!composeReady.project} required={false} maxLength={2000} onChange={value=>changeProjectForm({...projectForm,sourceUrl:value})}/></>:<>
              {(!project||project.permissions.manage)&&<><label>以什么身份参与<select value={projectForm.participantKind} onChange={event=>changeProjectForm({...projectForm,participantKind:event.target.value})}>{[['unknown','暂不说明'],['human','个人'],['agent','Agent'],['team','团队'],['tool','工具'],['organization','组织'],['service','服务']].map(([id,label])=><option key={id} value={id}>{label}</option>)}</select><small>这是你对参与身份的说明。</small></label><label className="check-label"><input type="checkbox" checked={projectForm.discoverable} onChange={event=>changeProjectForm({...projectForm,discoverable:event.target.checked})}/>允许别人发现这个项目</label><p className="record-meta">是否接收联系还遵循你的交流意愿设置。</p></>}
              <label>谁可以阅读这份介绍<select value={visibility} onChange={event=>changeCompose('project',{visibility:event.target.value})}><option value="Private">自己和指定的人</option><option value="Public">公开</option></select></label>{visibility==='Private'&&<fieldset disabled={busy||!composeReady.project}><legend>另行允许的人（可选）</legend><p className="record-meta">你自己已经可以阅读；这里只选择还要分享给谁。</p>{audienceChoices.length>6&&<label htmlFor={fieldId+'-audience'}>查找项目成员或联系人<Input id={fieldId+'-audience'} value={audienceSearch} onChange={event=>setAudienceSearch(event.target.value)}/></label>}{audienceChoices.filter(id=>!audienceSearch||name(id).includes(audienceSearch)).map(id=><label className="check-label" key={id}><input type="checkbox" checked={tags(viewers).includes(id)} onChange={event=>changeCompose('project',{viewers:(event.target.checked?[...tags(viewers),id]:tags(viewers).filter(value=>value!==id)).join('\n')})}/><MemberAvatar subjectId={id}/><span>{name(id)}</span></label>)}{!audienceLoaded&&<p className="record-meta">正在读取联系人…</p>}{audienceLoaded&&!audienceError&&!audienceChoices.length&&<p className="record-meta">当前没有读到其他项目成员或联系人。</p>}{audienceAfter&&<button type="button" className="text-link" onClick={()=>run(()=>loadAudience(audienceAfter))}>更多联系人</button>}{audienceError&&<p className="record-meta">{audienceError}<button type="button" className="text-link" onClick={()=>run(()=>loadAudience(audienceAfter??undefined))}>重新读取联系人</button></p>}<ReadingDetails mode="inline" className="technical-details"><ReadingSummary>补充其他已知身份</ReadingSummary><label htmlFor={fieldId+'-viewers'}>已有的银河 ID（每行一位）<Textarea id={fieldId+'-viewers'} value={viewers} onChange={event=>changeCompose('project',{viewers:event.target.value})}/></label></ReadingDetails></fieldset>}
            </>}
            <div className="button-row">{projectStep>0&&<Button type="button" variant="outline" onClick={()=>changeCompose('project',{step:0},false)}>上一步</Button>}<Button type="submit" disabled={busy||!writable||!composeReady.project||(projectStep===1&&projectComposePending)||!projectForm.title.trim()||!projectForm.summary.trim()||!tags(projectForm.functions).length}>{projectStep===0?'继续':'预览项目介绍'}</Button></div>
          </form>
        </>}</section>}
        {projectMode==='roles'&&project?.permissions.manage&&<section className="project-editor project-management-people" aria-label="项目协作权限">
          <div className="reading-list">{(project.management?.roles??[]).map(item=><article className="member-permission-row" key={item.subjectId+item.role}><div className="member-line"><MemberAvatar subjectId={item.subjectId}/><div><strong>{name(item.subjectId)}</strong><p>{projectRoleNames[item.role]} · {projectRoleDetails[item.role]}</p></div></div><button className="text-link" disabled={busy||projectComposePending||project.state!=='active'} onClick={()=>confirmAction('撤销协作角色',<p>撤销 {name(item.subjectId)} 在 {project.document?.title} 的{projectRoleNames[item.role]}角色。</p>,()=>projectWrite({kind:'revoke-role',subjectId:item.subjectId,role:item.role},[item.subjectId]))}>撤销角色</button></article>)}</div>
          <ProjectPeopleSelection key={project.projectId+':roles'} runtime={runtime} subjectId={subjectId!} client={client!} project={project} kind="roles" busy={busy} pending={pending} onRun={run} onWrite={projectWrite} onRead={setProject} onReview={reviewManagementOperation} onBack={()=>managementLocation('read')} onShare={()=>run(()=>openComposer('project',project.projectId))}/>
        </section>}
        {projectMode==='transfer'&&project?.permissions.manage&&<section className="project-editor project-management-people" aria-label="项目管理转交"><ProjectPeopleSelection key={project.projectId+':transfer'} runtime={runtime} subjectId={subjectId!} client={client!} project={project} kind="transfer" busy={busy} pending={pending} onRun={run} onWrite={projectWrite} onRead={setProject} onReview={reviewManagementOperation} onBack={()=>managementLocation('read')} onShare={()=>run(()=>openComposer('project',project.projectId))}/></section>}
        {projectMode==='preferences'&&project&&projectPreferences&&discoveryPreferences&&subjectId&&<ProjectContactPreferences key={project.projectId+':'+projectPreferences.revision} runtime={runtime} subjectId={subjectId} project={project} global={discoveryPreferences} saved={projectPreferences} onSaved={value=>{setProjectPreferences(value);setMessage('这份作品的联系范围已保存。');}} onBack={()=>setProjectMode('read')}/>}
      </>}
    </>}
    {tab==='recruitment'&&<>
      {recruitMode==='list'?<>
        <div className="section-heading"><p>为公开项目寻找持续参与的角色。</p><Button disabled={!writable||busy} onClick={()=>run(()=>openComposer('recruitment'))}>发布招募</Button></div>
        <div className="reading-list">{recruits.map(item=><article className="reading-list-item project-list-row" key={item.recruitmentId}><button className="reading-title-link" onClick={()=>{leaveComposer('recruitment',item.recruitmentId);editRecruitment(item);setRecruitMode('read');}}>{item.document?.title??'当前内容不可读取'}</button><p>{item.document?.summary}</p><p className="record-meta">{stateNames[item.state]??item.state} · {item.document?.role}{item.expiresAt?' · 有效至 '+readableTime(item.expiresAt):''}</p></article>)}</div>
        {recruitsLoaded&&!recruits.length&&<p className="empty-state">还没有你管理的持续招募。</p>}{!recruitsLoaded&&writable&&<p><output>正在读取招募…</output></p>}{recruitNext&&<Button variant="outline" disabled={busy} onClick={()=>run(()=>loadRecruitments(recruitNext))}>更多招募</Button>}
      </>:<>
        <button className="back-link" onClick={()=>{leaveComposer('recruitment');setRecruitMode('list');}}> 回到持续招募</button>
        {recruitMode==='read'&&recruit&&<article className="project-reading"><h2>{recruit.document?.title??'当前内容不可读取'}</h2><p className="record-meta">{stateNames[recruit.state]??recruit.state} · {readableTime(recruit.expiresAt)}</p><h3>希望找到的角色</h3><p>{recruit.document?.role}</p><p className="reading-prose">{recruit.document?.summary}</p>{recruit.document?.conditions&&<><h3>参与条件与时间</h3><p className="reading-prose">{recruit.document.conditions}</p></>}<p>{recruit.document?.functions?.join('、')}</p><div className="button-row"><Button disabled={busy||recruit.state==='closed'} onClick={()=>run(()=>openComposer('recruitment',recruit.recruitmentId))}>编辑招募</Button><Button variant="outline" disabled={busy} onClick={()=>run(async()=>{await loadTasks();setRecruitMode('link');})}>关联已有求助</Button>{recruit.state!=='closed'&&<><button className="text-link" disabled={busy} onClick={()=>confirmAction('暂停招募',<p>暂停 {recruit.document?.title} 的新分发。</p>,()=>recruitWrite('pause'))}>暂停</button><button className="text-link" disabled={busy} onClick={()=>confirmAction('关闭招募',<p>关闭 {recruit.document?.title}。已经关联的求助保持各自状态。</p>,()=>recruitWrite('close'))}>关闭招募</button></>}</div>{recruit.taskLinks?.map(link=><p key={link.taskId}><button className="text-link" onClick={()=>navigate('/app/tasks/'+link.taskId)}>打开已关联的求助</button><small className="record-meta"> · {link.taskId.slice(0,8)}</small></p>)}</article>}
        {recruitMode==='edit'&&<section className="project-editor">{!composeReady.recruitment?<><p><output>{busy?'正在读取招募和本机草稿…':'草稿尚未打开。'}</output></p><Button variant="outline" disabled={busy} onClick={()=>run(()=>openComposer('recruitment',compose.current.recruitment?.targetId==='new'?undefined:compose.current.recruitment?.targetId))}>重新打开草稿</Button></>:<><nav className="flow-steps" aria-label="招募编辑步骤"><button aria-current={recruitStep===0?'step':undefined} onClick={()=>changeCompose('recruitment',{step:0},false)}>1. 角色与工作</button><button aria-current={recruitStep===1?'step':undefined} onClick={()=>{if(recruitmentSourceReady&&recruitProjectId&&recruitForm.title.trim()&&recruitForm.role.trim()&&recruitForm.summary.trim()&&tags(recruitForm.functions).length)changeCompose('recruitment',{step:1},false);}}>2. 条件与期限</button></nav>
          <form className="workspace-form" onSubmit={event=>{event.preventDefault();if(!recruitmentSourceReady||recruitStep===1&&publicationLimited)return;if(recruitStep===0){changeCompose('recruitment',{step:1},false);return;}confirmAction(recruit?'更新持续招募':'发布持续招募',<><h3>{recruitForm.title}</h3><p>项目：{projects.find(item=>item.projectId===recruitProjectId)?.document?.title??'所选项目'}</p><p>角色：{recruitForm.role}</p><p className="reading-prose">{recruitForm.summary}</p><p>方向：{recruitForm.functions}</p>{recruitForm.technologies&&<p>工具与技术：{recruitForm.technologies}</p>}{recruitForm.conditions&&<p className="reading-prose">{recruitForm.conditions}</p>}<p>公开发布，从本次发布起 {recruitForm.days} 天内有效。联系人是你。</p></>,async()=>{if(await recruitWrite(recruit?'revise':'create'))setRecruitMode('read');});}}>
            <h2>{recruit?'编辑招募':'希望谁来一起参与？'}</h2>{composeStatus.recruitment&&<p className="record-meta"><output>{composeStatus.recruitment}</output></p>}{recruitStep===0?<><label>代表的项目<select required disabled={busy||!!recruit} value={recruitProjectId} onChange={event=>changeCompose('recruitment',{projectId:event.target.value})}><option value="">选择你管理或代表的公开项目</option>{recruitProjectId&&!recruitmentProjects.some(item=>item.projectId===recruitProjectId)&&<option value={recruitProjectId} disabled>{projects.find(item=>item.projectId===recruitProjectId)?.document?.title??'先前选择的项目'}（当前不能公开招募）</option>}{recruitmentProjects.map(item=><option key={item.projectId} value={item.projectId}>{item.document?.title??'当前介绍不可读取'}</option>)}</select></label><p className="record-meta">只有公开且未归档、你当前能够对外代表的项目，才可以发布招募。</p>{projectNext&&<button type="button" className="text-link" disabled={busy} onClick={()=>run(()=>loadProjects(projectNext))}>更多可选项目</button>}{projectsLoaded&&!recruitmentProjects.length&&<p className="record-meta">当前读到的项目中还没有可用于公开招募的项目，可以先到“我的项目”整理公开介绍。</p>}<ProjectTextField label="招募名称" value={recruitForm.title??''} disabled={busy||!composeReady.recruitment} required={true} maxLength={120} onChange={value=>changeRecruitForm({...recruitForm,title:value})}/><ProjectTextField label="希望找到的角色" value={recruitForm.role??''} disabled={busy||!composeReady.recruitment} required={true} maxLength={500} onChange={value=>changeRecruitForm({...recruitForm,role:value})}/><ProjectTextField label="具体工作" value={recruitForm.summary??''} disabled={busy||!composeReady.recruitment} required={true} maxLength={3000} multiline onChange={value=>changeRecruitForm({...recruitForm,summary:value})}/><ProjectTextField label="相关功能（逗号分隔）" value={recruitForm.functions??''} disabled={busy||!composeReady.recruitment} required={true} maxLength={2000} onChange={value=>changeRecruitForm({...recruitForm,functions:value})}/></>:<><ProjectTextField label="参与条件与时间（可选）" value={recruitForm.conditions??''} disabled={busy||!composeReady.recruitment} required={false} maxLength={2000} multiline onChange={value=>changeRecruitForm({...recruitForm,conditions:value})}/><ProjectTextField label="使用的技术（可选）" value={recruitForm.technologies??''} disabled={busy||!composeReady.recruitment} required={false} maxLength={2000} onChange={value=>changeRecruitForm({...recruitForm,technologies:value})}/><label htmlFor={fieldId+'-days'}>发布后有效天数<Input id={fieldId+'-days'} type="number" min={1} max={30} required value={recruitForm.days} onChange={event=>changeRecruitForm({...recruitForm,days:Number(event.target.value)})}/></label><p className="record-meta">招募以公开项目及当前代表权为基础。具体参与内容由你与回应者进一步商定。</p></>}
            {recruitProjectId&&recruitProjectCheck.state==='reading'&&<p className="record-meta"><output>正在读取项目的公开介绍与当前代表权限…</output></p>}{recruitProjectId&&recruitProjectCheck.state==='failed'&&<p className="message error" role="alert">{recruitProjectCheck.message}<button type="button" className="text-link" disabled={busy} onClick={()=>setRecruitProjectRead(value=>value+1)}>重新读取项目</button></p>}{publicationLimited&&<p className="message"><output>今天可公开发布的求助和招募次数已用完。内容仍保存在本机，可在 {readableTime(publicationQuota.resetAt??undefined)} 后继续发布。</output></p>}<div className="button-row">{recruitStep>0&&<Button type="button" variant="outline" onClick={()=>changeCompose('recruitment',{step:0},false)}>上一步</Button>}<Button type="submit" disabled={busy||!writable||!composeReady.recruitment||!recruitmentSourceReady||(recruitStep===1&&(recruitComposePending||publicationLimited))||!recruitProjectId||recruit?.state==='closed'||!recruitForm.title.trim()||!recruitForm.role.trim()||!recruitForm.summary.trim()||!tags(recruitForm.functions).length}>{recruitStep===0?'继续':'预览招募'}</Button>{recruit&&recruitStep===1&&<Button type="button" variant="outline" disabled={busy||!composeReady.recruitment||!recruitmentSourceReady||recruitComposePending||publicationLimited||recruit.state==='closed'} onClick={()=>confirmAction('续期招募',<><h3>{recruitForm.title}</h3><p className="reading-prose">{recruitForm.summary}</p><p>角色：{recruitForm.role} · 方向：{recruitForm.functions}</p><p>{recruitForm.conditions}</p><p>按当前内容公开续期 {recruitForm.days} 天。</p></>,async()=>{if(await recruitWrite('renew'))setRecruitMode('read');})}>预览续期</Button>}</div>
          </form>
        </>}</section>}
        {recruitMode==='link'&&recruit&&<form className="workspace-form project-editor" onSubmit={event=>{event.preventDefault();confirmAction('关联已有求助',<p>将 <TaskCurrentTitle runtime={runtime} task={tasks.find(item=>item.taskId===taskId)} fallback="所选求助"/> 关联到 {recruit.document?.title}。求助的工作范围与状态保持原记录。</p>,async()=>{const task=await read('/v2/tasks/'+taskId);await recruitWrite('link-task',{taskId,expectedTaskVersion:task.version});setRecruitMode('read');});}}><h2>选择你发起的求助</h2><label>已有求助<select required value={taskId} onChange={event=>setTaskId(event.target.value)}><option value="">选择求助</option>{tasks.map(item=><option key={item.taskId} value={item.taskId}>{item.request?.title??item.title??'已有求助'}</option>)}</select></label>{taskNext&&<Button type="button" variant="outline" disabled={busy} onClick={()=>run(()=>loadTasks(taskNext))}>更多求助</Button>}{!tasks.length&&<p>还没有可关联的求助。</p>}<div className="button-row"><Button type="submit" disabled={busy||!taskId}>预览关联</Button><Button type="button" variant="outline" onClick={()=>setRecruitMode('read')}>返回</Button></div></form>}
      </>}
    </>}
    {tab==='contacts'&&<section>
      <div className="section-heading"><label className="inline-field">显示<select aria-label="联系方向" disabled={initialContactId!==undefined} value={direction} onChange={event=>setDirection(event.target.value)}><option value="both">所有联系</option><option value="incoming">收到的联系</option><option value="outgoing">我发起的联系</option></select></label>{initialContactId&&<button className="text-link" onClick={()=>navigate('/app/projects?section=contacts')}>查看全部联系</button>}</div>
      <div className="contact-candidate-list">{contacts.map(contact=><article className="contact-candidate" key={contact.contactId} data-contact-id={contact.contactId}>
        <div className="member-line"><MemberAvatar subjectId={contact.initiatorId===subjectId?contact.recipientId:contact.initiatorId}/><div><h3>{name(contact.initiatorId===subjectId?contact.recipientId:contact.initiatorId)}</h3><p>{contact.initiatorId===subjectId?'你发起的联系':'向你发来的联系'} · {contact.state==='sent'&&contact.recipientId===subjectId?'等待你的回应':stateNames[contact.state]??contact.state}</p></div></div>
        {contact.events.map(event=><section className="contact-message" key={event.operationId}><p className="record-meta">{contactEventNames[event.kind]??event.kind}{event.recordedAt?' · '+readableTime(event.recordedAt):''}</p><p className="reading-prose">{event.contentUnavailable?'原文当前不可读取。':event.note}</p></section>)}
        {contact.state==='sent'&&contact.recipientId===subjectId&&<ReadingDetails mode="inline" className="contact-response-note"><ReadingSummary>随回应留一句话（可选）</ReadingSummary><label htmlFor={fieldId+'-response-'+contact.contactId}>回应说明<Textarea id={fieldId+'-response-'+contact.contactId} aria-label="回应说明" disabled={busy||!writable} maxLength={2000} value={responseNotes[contact.contactId]??''} onChange={event=>setResponseNotes({...responseNotes,[contact.contactId]:event.target.value})}/></label></ReadingDetails>}
        <div className="button-row">{contact.state==='sent'&&(contact.recipientId===subjectId?<><Button disabled={busy||!writable||contact.sourceNeedsRefresh||!contact.events.some(event=>event.kind==='send'&&!event.contentUnavailable)} onClick={()=>{const returnFrom=location.pathname+location.search;void run(async()=>{const result=await respond(contact,'accept');if(result.state==='accepted'&&result.roomId&&composeMounted.current&&projectViewScope(runtime,connected)===viewScope&&location.pathname+location.search===returnFrom)navigate('/app/rooms/'+result.roomId);});}}>接受并打开对话</Button><button className="text-link" disabled={busy||!writable} onClick={()=>setContactReply({contact,kind:'decline'})}>婉拒</button></>:<button className="text-link" disabled={busy||!writable} onClick={()=>setContactReply({contact,kind:'withdraw'})}>撤回联系</button>)}{contact.state==='accepted'&&contact.roomId&&<Button onClick={()=>navigate('/app/rooms/'+contact.roomId)}>打开对话</Button>}<ContactSourceLinks runtime={runtime} subjectId={subjectId} connected={connected} navigate={navigate} contact={contact}/></div>
        {contact.recipientId===subjectId&&contact.state==='sent'&&!contact.events.some(event=>event.kind==='send'&&!event.contentUnavailable)&&<p className="record-meta">原联系说明当前不可读，暂不能接受。</p>}
      </article>)}</div>
      {contactsState==='loading'&&!contacts.length&&<p><output>正在读取联系…</output></p>}{contactsState==='failed'&&<Button variant="outline" disabled={busy} onClick={()=>run(()=>loadContacts())}>重新读取联系</Button>}{contactsState==='ready'&&!contacts.length&&<p className="empty-state">这个范围里还没有联系。</p>}{contactNext&&<Button variant="outline" disabled={busy} onClick={()=>run(()=>loadContacts(contactNext))}>更多联系</Button>}
    </section>}
    {tab==='willingness'&&<section className="project-editor"><h2>你愿意怎样被发现和联系</h2><p>开启后，符合这里所选目的的公开资料可以出现在发现结果中。</p>{discoveryPreferences?<form className="workspace-form" onSubmit={event=>{event.preventDefault();void run(()=>savePreferences({enabled:discoveryPreferences.preferences.enabled}));}}>
      <label className="check-label"><input type="checkbox" checked={discoveryPreferences.preferences.enabled} onChange={event=>setDiscoveryPreferences({...discoveryPreferences,preferences:{...discoveryPreferences.preferences,enabled:event.target.checked}})}/>允许长期被发现</label>
      <fieldset><legend>愿意交流什么</legend>{Object.entries(purposeNames).map(([key,label])=><label className="check-label" key={key} aria-label={label}><input type="checkbox" checked={discoveryPreferences.preferences.purposes.includes(discoveryPurpose(key))} onChange={event=>setDiscoveryPreferences({...discoveryPreferences,preferences:{...discoveryPreferences.preferences,purposes:event.target.checked?[...discoveryPreferences.preferences.purposes,discoveryPurpose(key)]:discoveryPreferences.preferences.purposes.filter((value:string)=>value!==key)}})}/>{label}</label>)}</fieldset>
      <Button type="submit" disabled={busy||!discoveryPreferences.preferences.purposes.length}>保存交流意愿</Button>
      {discoveryPreferences.preferences.temporary?<section className="operation-status"><p>当前有临时设置{discoveryPreferences.effective.temporaryUntil?'，至 '+readableTime(discoveryPreferences.effective.temporaryUntil):''}。</p><button type="button" className="text-link" disabled={busy} onClick={()=>run(()=>savePreferences({temporary:null}))}>恢复长期设置</button></section>:<button type="button" className="text-link" disabled={busy} onClick={()=>run(()=>savePreferences({temporary:{until:Math.floor(Date.now()/1000)+86400,contact:'paused'}}))}>暂停联系 24 小时</button>}
    </form>:writable&&<p><output>正在读取交流意愿…</output></p>}</section>}
    {tab==='discover'&&<>
      <form className="workspace-form project-search" onSubmit={event=>{event.preventDefault();void run(()=>search());}}><ProjectTextField label="当前目标" value={query.title??''} disabled={false} required={false} maxLength={120} onChange={value=>setQuery({...query,title:value})}/><ProjectTextField label="相关功能（逗号分隔）" value={query.functions??''} disabled={false} required={false} maxLength={2000} onChange={value=>setQuery({...query,functions:value})}/><ProjectTextField label="技术或环境（可选）" value={query.technologies??''} disabled={false} required={false} maxLength={2000} onChange={value=>setQuery({...query,technologies:value})}/><label>交流目的<select value={query.purpose} onChange={event=>setQuery({...query,purpose:discoveryPurpose(event.target.value)})}>{Object.entries(purposeNames).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label><Button type="submit" disabled={busy||!runtime}>寻找同行</Button></form>
      <div className="reading-list">{opportunities.map(item=><article className="contact-candidate" key={item.id}>{item.sourceUnavailable?<p>当前资料已不可读取，请重新查询。</p>:<><label className="contact-choice" aria-label={item.project.title+' · '+name(item.subjectId)}><input type="checkbox" disabled={!writable||busy} checked={selected.includes(item.id)} onChange={event=>setSelected(event.target.checked?[...selected,item.id]:selected.filter(id=>id!==item.id))}/><span><strong>{item.project.title}</strong><small>{name(item.subjectId)} · {item.help.functions.join('、')}</small></span></label><p className="reading-prose">{item.help.statement}</p><button className="text-link" disabled={busy} onClick={()=>run(async()=>{await inspect(item);setDetailOpen(true);})}>了解项目与参与条件</button></>}</article>)}</div>
      {searched&&!opportunities.length&&<p className="empty-state">当前没有找到可见机会，可以调整目标或相关功能。</p>}{queryNext&&<Button variant="outline" disabled={busy} onClick={()=>run(()=>search(queryNext))}>更多机会</Button>}
      {!!selected.length&&submitted&&<form className="workspace-form project-editor" onSubmit={event=>{event.preventDefault();confirmAction('分别发送联系',<><p>联系目的：{purposeNames[submitted.purposes[0]]}</p><p>当前目标：{submitted.context.kind==='ephemeral'?submitted.context.title:'所选项目'}</p>{opportunities.filter((item):item is Opportunity=>selected.includes(item.id)&&!item.sourceUnavailable).map(item=><p key={item.id}>{name(item.subjectId)} · {item.project.title}</p>)}<p className="reading-prose">{note}</p><p>对方接受后，对话名为“{roomTitle}”。</p></>,sendSelected);}}><h3>给所选的 {selected.length} 位联系人</h3><label htmlFor={fieldId+'-note'}>想交流什么<Textarea id={fieldId+'-note'} required maxLength={2000} value={note} onChange={event=>setNote(event.target.value)}/></label><label htmlFor={fieldId+'-room'}>对话名称<Input id={fieldId+'-room'} required maxLength={120} value={roomTitle} onChange={event=>setRoomTitle(event.target.value)}/></label><p className="record-meta">每个人分别收到这次目标、交流目的和说明。</p><Button type="submit" disabled={busy||!writable}>预览联系内容</Button></form>}
      {sourceDenied&&<p className="message">部分来源已改变或不可读，相关联系没有继续发送。</p>}
      {sendResults.length>0&&<section className="operation-status"><h3>联系结果</h3>{sendResults.map(item=><p key={item.id}>{name(item.subjectId)} · {item.result?stateNames[item.result.state]:item.unknown?'结果仍待确认':item.error}</p>)}<button className="text-link" onClick={()=>chooseTab('contacts')}>查看联系与回应</button></section>}
    </>}
    <dialog ref={pendingDialog} className="workspace-dialog project-confirmation" onCancel={event=>{if(busy)event.preventDefault();else setPendingReview(null);}}>{pendingReview&&<><header className="dialog-heading"><span>继续原提交</span><button className="icon-button" aria-label="关闭原提交" disabled={busy} onClick={()=>setPendingReview(null)}>×</button></header><SavedOperationContent review={pendingReview} name={name}/>{pendingReview.authorization==='review-required'&&<p>这份内容还需要你确认后授权提交。</p>}{operationWaitText(pending.find(item=>item.operationId===pendingReview.operationId)??pendingReview)&&<p><output>{operationWaitText(pending.find(item=>item.operationId===pendingReview.operationId)??pendingReview)}</output></p>}{error&&<p className="message error" role="alert">{error}</p>}<div className="button-row"><Button disabled={busy||pendingReview.state==='stopped-local'||operationWaiting(pending.find(item=>item.operationId===pendingReview.operationId)??pendingReview,now)} onClick={()=>run(async()=>{await client!.reconcile(pendingReview.operationId,{retry:true,confirmed:true});const checked=await client!.reviewPending(pendingReview.operationId);if(checked?.state==='acknowledged'){setPendingReview(null);setMessage('这次提交已完成。');await settleOpenComposers();await refreshVisible();}else{if(checked?.payload)setPendingReview(checked);setMessage(operationWaitText(checked)||'这次提交仍待确认，原内容已保留。');}})}>确认继续提交</Button><Button variant="outline" disabled={busy} onClick={()=>setPendingReview(null)}>稍后继续</Button></div></>}</dialog>
    <dialog ref={previewDialog} className="workspace-dialog project-confirmation" onCancel={event=>{if(busy)event.preventDefault();else setConfirmation(null);}}>
      {confirmation&&<><header className="dialog-heading"><span>{confirmation.title}</span><button className="icon-button" aria-label="关闭操作预览" disabled={busy} onClick={()=>setConfirmation(null)}>×</button></header>{confirmation.body}{error&&<p className="message error" role="alert">{error}</p>}<div className="button-row"><Button disabled={busy} onClick={()=>run(async()=>{await confirmation.execute();setConfirmation(null);})}>{confirmation.title}</Button><Button variant="outline" disabled={busy} onClick={()=>setConfirmation(null)}>返回修改</Button></div></>}
    </dialog>
    <dialog ref={contactDialog} className="workspace-dialog" onCancel={event=>{if(busy)event.preventDefault();else setContactReply(null);}}>
      {contactReply&&<><header className="dialog-heading"><span>{contactReply.kind==='accept'?'接受交流':contactReply.kind==='decline'?'婉拒这次联系':'撤回这次联系'}</span><button className="icon-button" disabled={busy} aria-label="关闭联系回应" onClick={()=>setContactReply(null)}>×</button></header><p>{contactReply.kind==='accept'?'接受后建立你们双方的对话，可以继续讨论。':'这次选择只影响当前联系。'}</p><form className="workspace-form" onSubmit={event=>{event.preventDefault();void run(async()=>{await respond(contactReply.contact,contactReply.kind);setContactReply(null);});}}><label htmlFor={fieldId+'-reply'}>留一句话（可选）<Textarea id={fieldId+'-reply'} maxLength={2000} value={responseNotes[contactReply.contact.contactId]??''} onChange={event=>setResponseNotes({...responseNotes,[contactReply.contact.contactId]:event.target.value})}/></label>{error&&<p className="message error" role="alert">{error}</p>}<div className="button-row"><Button type="submit" disabled={busy}>{contactReply.kind==='accept'?'接受并开始交流':contactReply.kind==='decline'?'确认婉拒':'确认撤回'}</Button><Button type="button" variant="outline" disabled={busy} onClick={()=>setContactReply(null)}>返回</Button></div></form></>}
    </dialog>
    <dialog ref={detailDialog} className="workspace-dialog" onCancel={()=>setDetailOpen(false)}>
      {detailOpen&&detail&&<><header className="dialog-heading"><span>项目与参与条件</span><button className="icon-button" aria-label="关闭项目资料" onClick={()=>setDetailOpen(false)}>×</button></header><h2>{detail.opportunity.project.title}</h2><p className="reading-prose">{detail.opportunity.project.summary}</p><p>{detail.opportunity.help?.statement}</p>{detail.experience.items.map(item=><section key={item.key}><h3>{item.title??item.kind}</h3><FactDetails item={item} runtime={runtime} connected={connected} subjectId={subjectId??undefined} navigate={navigate}/></section>)}{!detail.experience.items.length&&<p>当前没有可见的工作经历。</p>}{(detail.experience.nextCursor??detail.experience.nextAfter)&&<Button variant="outline" disabled={busy} onClick={()=>run(()=>inspect(detail.opportunity,detail.experience.nextCursor??detail.experience.nextAfter))}>更多经历</Button>}</>}
    </dialog>
  </section>;
}

type ProjectPeopleSelectionProps={
  runtime:ProjectRuntime;subjectId:string;client:ProjectContactClient;project:ProjectView;kind:'roles'|'transfer';busy:boolean;pending:PendingProjectOperation[];
  onRun:(action:()=>Promise<void>)=>Promise<void>;
  onWrite:(event:ProjectChoice,viewers:string[],selection:ProjectSelection)=>Promise<boolean>;
  onRead:(value:ProjectView)=>void;onReview:(operationId:string)=>Promise<void>;onBack:()=>void;onShare:()=>void;
};
function ProjectPeopleSelection({runtime,subjectId,client,project,kind,busy,pending,onRun,onWrite,onRead,onReview,onBack,onShare}:ProjectPeopleSelectionProps){
  const [lease]=useState(()=>runtime.receiptStatus.captureLease());
  const initial=useMemo<ProjectPeopleForm>(()=>({person:'',query:'',role:'editor'}),[]);
  const draft=useGovernanceDraft<ProjectPeopleForm,ProjectSelectionLocator>(runtime,subjectId,true,'project-management-input:v1:'+JSON.stringify([runtime.api.endpoint,subjectId,project.projectId,kind]),initial);
  const draftRef=useRef(draft);
  useEffect(()=>{draftRef.current=draft;},[draft]);
  const peopleFieldId=useId();
  const form={person:typeof draft.value.person==='string'?draft.value.person:'',query:typeof draft.value.query==='string'?draft.value.query:'',role:projectRole(draft.value.role)};
  const [contacts,setContacts]=useState<string[]>([]),[next,setNext]=useState<string|null>(null),[loaded,setLoaded]=useState(false),[loading,setLoading]=useState(false),[readError,setReadError]=useState(''),[issue,setIssue]=useState(''),[notice,setNotice]=useState('');
  const mounted=useRef(true),reading=useRef(false),request=useRef(0),pages=useRef(1);
  const current=()=>{try{lease.assertCurrent();return mounted.current;}catch{return false;}};
  const check=()=>{lease.assertCurrent();if(!mounted.current)throw Error('这次选择已收起，原稿仍保留。');};
  const roles=project.management?.roles??[],transfers=project.management?.transfers??[];
  const memberIds=[...new Set<string>(roles.map(item=>item.subjectId))];
  const people=[...new Set([...memberIds,...contacts])].filter(id=>id!==subjectId&&id!==project.ownerId);
  const names=useMemberNames(runtime,subjectId,true,[...people,form.person]);
  const name=(id:string)=>memberName(id,subjectId,names[id]??undefined);
  const shown=people.filter(id=>!form.query.trim()||name(id).toLocaleLowerCase().includes(form.query.trim().toLocaleLowerCase()));
  const retained=pending.filter(item=>item.type==='project'&&item.objectId===project.projectId),pendingKey=JSON.stringify(retained.map(item=>[item.operationId,item.state]));
  const validPerson=/^GUID[A-Z0-9]{28}$/.test(form.person)&&form.person!==subjectId&&form.person!==project.ownerId;
  const alreadyAssigned=kind==='roles'&&roles.some(item=>item.subjectId===form.person&&item.role===form.role);
  const offered=transfers.some(item=>item.state==='offered'),active=project.state==='active'&&project.permissions?.manage;
  async function loadContacts(){
    if(reading.current||!current())return;reading.current=true;const version=++request.current;setLoading(true);setReadError('');
    try{
      const ids:string[]=[];let after:string|undefined;
      for(let page=0;page<pages.current;page++){
        const value:ContactsPage=await runtime.api.call('/v2/contacts/query',{direction:'both',limit:50,...(after?{after}:{})});check();if(version!==request.current)return;
        for(const item of value.items??[])if(item.state==='accepted'){const id=item.initiatorId===subjectId?item.recipientId:item.initiatorId;if(typeof id==='string'&&/^GUID[A-Z0-9]{28}$/.test(id)&&id!==subjectId&&!ids.includes(id))ids.push(id);}
        const more=value.nextAfter??undefined;if(more&&more===after)throw Error('联系人列表暂时不能继续读取。');after=more;if(!after)break;
      }
      if(version===request.current){setContacts(ids);setNext(after??null);setLoaded(true);}
    }catch{if(current()&&version===request.current){setContacts([]);setNext(null);setLoaded(true);setReadError('联系人暂未读取成功。你已保存的选择和当前项目成员仍可查看。');}}
    finally{if(version===request.current){reading.current=false;if(current())setLoading(false);}}
  }
  const refreshPeople=useEffectEvent(()=>{void loadContacts();});
  useEffect(()=>{
    const mountRef=mounted,requestRef=request,readingRef=reading;mountRef.current=true;const refresh=()=>{if(!document.hidden)refreshPeople();};refresh();const timer=window.setInterval(refresh,20000);document.addEventListener('visibilitychange',refresh);
    return()=>{mountRef.current=false;requestRef.current++;readingRef.current=false;window.clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};
  },[runtime,project.projectId,kind]);
  const settleSelection=useEffectEvent(()=>{void draft.settle(locator=>projectSelectionReceipt(client,project.projectId,locator)).then(removed=>{if(removed&&current())setNotice('上次修改已保存。');}).catch(()=>{if(current())setIssue('暂时无法核对上次修改，原选择仍保留。');});});
  useEffect(()=>{if(draft.ready)settleSelection();},[draft.ready,draft.attempt?.operationId,pendingKey]);
  function change(patch:Partial<ProjectPeopleForm>){if(!draft.ready||!current())return;draft.change(patch);setIssue('');setNotice('');}
  async function submitSelection(){
    setIssue('');setNotice('');
    try{
      const snapshot=await draftRef.current.snapshot();check();const selected=snapshot.value;
      if(typeof selected.person!=='string'||!/^GUID[A-Z0-9]{28}$/.test(selected.person)||selected.person===subjectId||selected.person===project.ownerId)throw Error('请选择其他项目成员或联系人，或填写对方完整的银河 ID。');
      if(kind==='roles'&&!['editor','representative'].includes(selected.role))throw Error('请选择这次要授予的角色。');
      const attempt=draftRef.current.attempt;
      if(attempt?.kind==='project-management'&&attempt.projectId===project.projectId&&typeof attempt.operationId==='string'){
        const original=await client!.reviewPending(attempt.operationId);check();
        if(original?.state==='acknowledged'){
          await draftRef.current.settle(locator=>projectSelectionReceipt(client,project.projectId,locator));check();
          const received:ProjectView=await runtime.api.call('/v2/projects/'+project.projectId,undefined,{method:'GET'});check();onRead(received);setNotice('上次修改已保存。');return;
        }
        if(original?.payload){await onReview(attempt.operationId);return;}
      }
      const previous=(await client!.pending()).find(item=>item.type==='project'&&item.objectId===project.projectId);check();
      if(previous){await onReview(previous.operationId);return;}
      const fresh:ProjectView=await runtime.api.call('/v2/projects/'+project.projectId,undefined,{method:'GET'});check();
      if(fresh.projectId!==project.projectId)throw Error('当前项目暂时无法准确核对，请重新读取。');onRead(fresh);
      if(!fresh.permissions?.manage)throw Error('当前身份已不能管理这个项目，未提交的选择仍保留。');
      if(fresh.state!=='active')throw Error('这个项目已归档，请恢复项目后再调整管理关系。');
      if(fresh.revision!==project.revision)throw Error('项目刚刚有更新，已重新读取。请核对当前项目与角色后再继续。');
      if(kind==='roles'&&fresh.management?.roles?.some(item=>item.subjectId===selected.person&&item.role===selected.role)){setNotice(name(selected.person)+' 已具有这个角色。');return;}
      if(kind==='transfer'&&fresh.management?.transfers?.some(item=>item.state==='offered')){setNotice('这个项目已有待接受的转交邀请，请回到项目查看原邀请。');return;}
      const selectedRole=projectRole(selected.role);if(kind==='roles'&&!selectedRole)throw Error('请选择这次要授予的角色。');
      const event:ProjectChoice=kind==='roles'&&selectedRole?{projectId:project.projectId,expectedRevision:fresh.revision,kind:'grant-role',subjectId:selected.person,role:selectedRole}:{projectId:project.projectId,expectedRevision:fresh.revision,kind:'offer-transfer',transferId:crypto.randomUUID(),toSubjectId:selected.person};
      const completed=await onWrite(event,[selected.person],{draft:draftRef.current,revision:snapshot.revision});
      if(!current()||!completed)return;
      if(kind==='transfer')onBack();
    }catch(error:unknown){
      if(current())setIssue(projectErrorFlag(error,"operationAcknowledged")?'这次项目操作已收到，当前列表暂未重新读取。':projectErrorFlag(error,"resultUnknown")||projectErrorFlag(error,"originalOperationRetained")?'这次提交仍待确认，原选择已保留。请查看原提交。':/[\u3400-\u9fff]/.test(projectErrorText(error))?projectErrorText(error):'这次项目设置暂未完成，原选择仍保留。');
      throw error;
    }
  }
  return <form className="workspace-form project-people-selection" onSubmit={event=>{event.preventDefault();void onRun(submitSelection);}}>
    <fieldset disabled={busy||!draft.ready}>
      <label htmlFor={peopleFieldId+'-query'} aria-label={kind==='roles'?'选择协作者':'选择接手的人'}>{kind==='roles'?'选择协作者':'选择接手的人'}<Input id={peopleFieldId+'-query'} value={form.query} onChange={event=>change({query:event.target.value})} placeholder="查找项目成员或联系人"/></label>
      <div className="project-person-options" role="radiogroup" aria-label={kind==='roles'?'选择共同维护的人':'选择接手项目的人'}>
        {shown.map(id=>{const assigned=kind==='roles'&&roles.some(item=>item.subjectId===id&&item.role===form.role);return <label className={'project-person-option'+(form.person===id?' selected':'')} key={id}><input type="radio" name={'project-person-'+kind+'-'+project.projectId} checked={form.person===id} onChange={()=>change({person:id})}/><MemberAvatar subjectId={id}/><span><strong>{name(id)}</strong><small>{memberIds.includes(id)?'项目成员 · '+roles.filter(item=>item.subjectId===id).map(item=>projectRoleNames[item.role]).join('、'):'联系人'}{assigned?' · 已有这一角色':''}</small></span></label>;})}
      </div>
      {loading&&!loaded&&<p className="record-meta"><output>正在读取联系人…</output></p>}
      {loaded&&!loading&&!shown.length&&!readError&&<p className="record-meta">{form.query?'当前列表中没有匹配的姓名。':'当前没有读到其他项目成员或已接受联系的人。'}</p>}
      {next&&<button type="button" className="text-link" disabled={loading} onClick={()=>{pages.current++;void loadContacts();}}>更多联系人</button>}
      {readError&&<p className="record-meta"><output>{readError} <button type="button" className="text-link" disabled={loading} onClick={()=>void loadContacts()}>重新读取</button></output></p>}
      <ReadingDetails mode="inline" className="project-known-person"><ReadingSummary>使用对方给我的银河 ID</ReadingSummary><label htmlFor={peopleFieldId+'-known'}>对方的银河 ID<Input id={peopleFieldId+'-known'} value={form.person} maxLength={32} pattern="GUID[A-Z0-9]{28}" onChange={event=>change({person:event.target.value.trim()})} placeholder="粘贴完整银河 ID"/></label></ReadingDetails>
      {form.person&&!validPerson&&<p className="record-meta">{form.person===subjectId||form.person===project.ownerId?'你已经是这个项目的管理者。':'请输入完整的银河 ID。'}</p>}
      {validPerson&&!shown.includes(form.person)&&<p className="record-meta">已选择 {name(form.person)}{people.includes(form.person)?'，当前筛选未显示。':'。'}</p>}
      {kind==='roles'&&<label>协作角色<select value={form.role} onChange={event=>change({role:event.target.value})}>{!form.role&&<option value="">请选择角色</option>}<option value="editor">资料编辑</option><option value="representative">对外代表</option></select><small>{projectRoleDetails[form.role]}仅限本项目，不含私有文件或 AI 控制权限。</small></label>}
    </fieldset>
    {kind==='transfer'&&<p className="project-role-meaning">对方读到项目介绍并接受后才接手管理，此前仍由你管理。其他成员角色与资料来源保留。</p>}
    {project.visibility==='Private'&&<p className="project-sharing-note">介绍仍按原范围分享，请确认对方可读。<button type="button" className="text-link" disabled={busy} onClick={onShare}>查看分享范围</button></p>}
    {!active&&<p className="message">当前项目不能调整管理关系，未提交的选择仍保留。</p>}
    {!!retained.length&&<p className="project-selection-notice"><output>这个项目还有提交待确认，先核对原操作。<button type="button" className="text-link" disabled={busy} onClick={()=>void onRun(()=>onReview(retained[0].operationId))}>查看原提交</button></output></p>}
    {alreadyAssigned&&<p className="project-selection-notice">对方已经具有这个角色，可以在上方的成员列表中查看。</p>}
    {kind==='transfer'&&offered&&<p className="project-selection-notice">这个项目已有待接受的转交邀请，可以返回项目查看或取消原邀请。</p>}
    {notice&&<p className="project-selection-notice"><output>{notice}</output></p>}{issue&&<p className="message error" role="alert">{issue}</p>}
    <footer className="project-selection-footer"><Button type="submit" disabled={busy||!draft.ready||!active||!validPerson||!!retained.length||alreadyAssigned||kind==='roles'&&!form.role||kind==='transfer'&&offered}>{busy?'正在提交…':kind==='roles'?'授予'+(projectRoleNames[form.role]??'角色'):'邀请接手管理'}</Button>{draft.status&&<p className="project-selection-status"><output>{draft.status}</output></p>}</footer>
  </form>;
}
