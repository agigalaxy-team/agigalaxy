import {ReadingDetails,ReadingSummary} from "../../../shared/reading/reading-details";
import React,{useEffect,useEffectEvent,useId,useMemo,useRef,useState} from "react";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {MemberAvatar,memberName,useMemberNames} from "../../../shared/people/conversation-ui";
import {useGovernanceDraft} from "../../governance/governance-presentation";
import "./people-selection.css";
import {projectErrorFlag,projectErrorText,projectRole} from "../contracts";
import type {ProjectRuntime,ProjectContactClient,ProjectView,ContactsPage,PendingProjectOperation,ProjectChoice,ProjectSelection,ProjectPeopleForm,ProjectSelectionLocator} from "../contracts";

export const projectRoleNames:Record<string,string>={editor:'资料编辑',representative:'对外代表'};
export const projectRoleDetails:Record<string,string>={editor:'可以更新这个项目的介绍。',representative:'可以代表这个项目对外联系，并为公开项目发布持续招募。'};
export async function projectSelectionReceipt(client:ProjectContactClient,projectId:string,locator:ProjectSelectionLocator){
  if(locator?.kind!=='project-management'||locator.projectId!==projectId||typeof locator.operationId!=='string')return{state:'unknown'};
  const result=await client!.reviewPending(locator.operationId);
  return result?.state==='acknowledged'&&result.type==='project'&&result.objectId===projectId&&result.operationId===locator.operationId?{state:'acknowledged'}:{state:'unknown'};
}

type ProjectPeopleSelectionProps={
  runtime:ProjectRuntime;subjectId:string;client:ProjectContactClient;project:ProjectView;kind:'roles'|'transfer';busy:boolean;pending:PendingProjectOperation[];
  onRun:(action:()=>Promise<void>)=>Promise<void>;
  onWrite:(event:ProjectChoice,viewers:string[],selection:ProjectSelection)=>Promise<boolean>;
  onRead:(value:ProjectView)=>void;onReview:(operationId:string)=>Promise<void>;onBack:()=>void;onShare:()=>void;
};
export function ProjectPeopleSelection({runtime,subjectId,client,project,kind,busy,pending,onRun,onWrite,onRead,onReview,onBack,onShare}:ProjectPeopleSelectionProps){
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
