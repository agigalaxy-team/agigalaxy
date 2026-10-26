import { ReadingDetails, ReadingSummary } from "../../shared/reading/reading-details";
import React,{useCallback,useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Textarea} from '@/components/ui/textarea';
import {useGovernanceDraft} from "../governance/governance-presentation";
import {memberName,useMemberNames} from "../../shared/people/conversation-ui";
import {identityGroupDraftKey,identityGroupError,IdentityGroupPeoplePicker} from './identity-group-presentation';
import {IdentityGroupSources,identityGroupSourceSelection} from './identity-group-sources';
import type {IdentityGroup,IdentityGroupClient,IdentityGroupDisplayIntent,IdentityGroupDraft,IdentityGroupDraftRef,IdentityGroupEditorKind,IdentityGroupInput,IdentityGroupIntent,IdentityGroupLease,IdentityGroupResult,IdentityGroupRuntime} from './identity-group-types';

const blank=(subjectId:string,payload:IdentityGroupDisplayIntent|undefined,group:IdentityGroup|undefined):IdentityGroupInput=>({groupId:group?.groupId??crypto.randomUUID(),expectedVersion:group?.version??0,previousOperationId:group?.operationId??null,
 memberIds:payload?.memberIds??[subjectId],canonicalDisplayId:payload?.canonicalDisplayId??subjectId,visibility:payload?.visibility??'Private',viewers:payload?.viewers??[],sourceRefs:payload?.sourceRefs??[],attributionCorrections:payload?.attributionCorrections??[],memberQuery:'',memberManual:'',viewerQuery:'',viewerManual:'',sourceKind:'case-event',sourceChoice:null,reason:''});
type EditorProps={runtime:IdentityGroupRuntime;client:IdentityGroupClient;lease:IdentityGroupLease;subjectId:string;kind:IdentityGroupEditorKind;group?:IdentityGroup;payload?:IdentityGroupDisplayIntent;onBack:()=>void;onSaved:(receipt:IdentityGroupResult)=>void;registerDraft:(key:string,value:IdentityGroupDraftRef|null)=>void};
export function IdentityGroupEditor({runtime,client,lease,subjectId,kind,group,payload,onBack,onSaved,registerDraft}:EditorProps){
 const [initial]=useState(()=>blank(subjectId,payload,group)),key=identityGroupDraftKey(runtime.api.endpoint,subjectId,kind,kind==='create'?'new':initial.groupId),draft:IdentityGroupDraft=useGovernanceDraft(runtime,subjectId,true,key,initial),input={...initial,...draft.value},draftRef=useRef(draft);
 useLayoutEffect(()=>{draftRef.current=draft;},[draft]);
 const active=useRef(true),working=useRef(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[changedGroup,setChangedGroup]=useState<IdentityGroup|null>(null);
 const names=useMemberNames(runtime,subjectId,true,[...input.memberIds,...input.viewers]),display=(id:string)=>memberName(id,subjectId,names[id]??undefined),isRevoke=kind==='revoke',isCreate=kind==='create',reasonId=useId();
 const check=useCallback(()=>{lease.assertCurrent();if(!active.current)throw Error('身份分组页面已关闭。');},[lease]);
 function change(patch:Partial<IdentityGroupInput>){setError('');setNotice('');draft.change(patch);}
 useEffect(()=>{active.current=true;registerDraft(key,draftRef);return()=>{active.current=false;registerDraft(key,null);};},[key,registerDraft]);
 const finish=useCallback(async(receipt:IdentityGroupResult)=>{check();const cleared=await draftRef.current.settle(client.receiptFor);check();if(cleared)onSaved(receipt);else setNotice('原操作已收到，后来修改的输入仍保留。');},[check,client,onSaved]);
 const attemptId=draft.attempt?.proofId;
 useEffect(()=>{if(!draft.ready||!attemptId)return;let reading=false;
  const tick=async()=>{const attempt=draftRef.current.attempt;if(!attempt||!active.current||reading||working.current||document.hidden)return;reading=true;try{const receipt=await client.receiptFor(attempt);check();if(receipt.state==='acknowledged')await finish(receipt);}catch{/* The retained operation explains recovery without discarding input. */}finally{reading=false;}};
  void tick();const timer=window.setInterval(tick,12000);document.addEventListener('visibilitychange',tick);return()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',tick);};
 },[draft.ready,attemptId,check,client,finish]);
 async function submit(){if(working.current)return;working.current=true;setBusy(true);setError('');setNotice('');
  try{check();let snapshot=await draftRef.current.snapshot();check();if(!snapshot.revision){draftRef.current.change({...initial,...snapshot.value});snapshot=await draftRef.current.snapshot();check();}const value={...initial,...snapshot.value};
   if(draftRef.current.attempt){const prior=await client.receiptFor(draftRef.current.attempt);check();if(prior.state==='acknowledged'){await finish(prior);return;}throw Error('这份内容已有原操作，正在核对结果。可以在下方继续原操作。');}
   const pending=await client.pending();check();if(pending.some(row=>row.groupId===value.groupId&&row.state!=='stopped-local'))throw Error('这份分组已有尚未完成的发送，请在下方查看或继续原操作。');
   if(isCreate){const current=await client.current();check();if(!current.availableActions?.includes('create'))throw Error('当前身份暂时不能发起分组。');}
   else{const current=await client.read(value.groupId);check();if(!current.availableActions?.includes(isRevoke?'revoke':'revise'))throw Error('这份分组当前不能'+(isRevoke?'撤销':'修改')+'，原输入仍保留。');if(current.version!==value.expectedVersion||current.operationId!==value.previousOperationId){setChangedGroup(current);throw Error('分组已经变化。请查看当前身份范围，再决定是否继续原输入。');}}
   if(!isRevoke){if(value.memberIds.length<2||value.memberIds.length>8)throw Error('请选择 2 至 8 个自己使用的身份。');if(!value.memberIds.every((id:string)=>/^GUID[0-9A-Z]{28}$/.test(id)))throw Error('选择的身份编号不完整，请重新选择。');if(!value.memberIds.includes(value.canonicalDisplayId))throw Error('请从已选身份中选择主要展示身份。');if(isCreate&&!value.memberIds.includes(subjectId))throw Error('新分组需要包含当前身份。');if(value.viewers.length>16)throw Error('最多可以指定 16 个额外查看者。');
    for(const ref of value.sourceRefs){if(!value.memberIds.includes(ref.originalSubjectId))throw Error('所选原记录的作者必须在分组中，请保留该身份或移出这条记录。');if(ref.originalSubjectId===subjectId){const source=await client.source(identityGroupSourceSelection(ref));check();if(source.ref.sourceHash!==ref.sourceHash||source.ref.originalSubjectId!==ref.originalSubjectId)throw Error('所选原记录已经变化，请重新选择。');}}
    for(const correction of value.attributionCorrections){if(!value.memberIds.includes(correction.displaySubjectId))throw Error('请为原记录选择分组中的展示身份。');if(!correction.reason.trim())throw Error('请填写调整记录展示的原因。');}
   }else if(!value.reason.trim())throw Error('请填写撤销分组的原因。');
   const now=Math.floor(Date.now()/1000),common={schemaVersion:2 as const,operationId:crypto.randomUUID(),groupId:value.groupId,expectedVersion:value.expectedVersion,previousOperationId:value.previousOperationId,endpoint:runtime.api.endpoint,issuedAt:now,expiresAt:now+86400};
   const intent:IdentityGroupIntent=isRevoke?{...common,kind:'revoke',reason:value.reason.trim()}:{...common,kind:isCreate?'create':'revise',memberIds:value.memberIds,canonicalDisplayId:value.canonicalDisplayId,visibility:value.visibility,viewers:value.visibility==='Public'?[]:value.viewers,sourceRefs:value.sourceRefs,attributionCorrections:value.attributionCorrections.map(item=>({...item,reason:item.reason.trim()})),purpose:'canonical-display-only',capabilityMerged:false,accessGranted:false};
   const preview=await client.prepare(intent);check();const receipt=await client.execute(preview,{confirmed:true,onJournal:locator=>draftRef.current.attach(locator,snapshot.revision)});check();if(receipt.state==='acknowledged')await finish(receipt);else setNotice('原操作尚未确认收到，输入已保留。');
  }catch(cause){if(active.current){try{check();setError(identityGroupError(cause));}catch{/* A new identity owns the new view. */}}}finally{working.current=false;if(active.current)setBusy(false);}
 }
 if(!draft.ready)return <output>正在恢复本机输入…{draft.status}</output>;
 return <form className="ig-editor" onSubmit={e=>{e.preventDefault();void submit();}}>
  <header><h3>{isCreate?'建立自己的身份分组':isRevoke?'撤销整个身份分组':'调整身份分组'}</h3><p>{isRevoke?'撤销后，这些身份停止共同展示。原身份、作品、作者、签名和各自权限保留。':'把自己使用的多个银河身份共同展示。每个身份都要分别同意，原身份和各自控制权继续保留。'}</p></header>
  {isRevoke?<label htmlFor={reasonId}>撤销原因<Textarea id={reasonId} required maxLength={800} value={input.reason} disabled={busy} onChange={e=>change({reason:e.target.value})} placeholder="说明为何停止这份共同展示关系"/></label>:<>
   <IdentityGroupPeoplePicker runtime={runtime} client={client} lease={lease} subjectId={subjectId} value={input.memberIds} onChange={(memberIds:string[])=>change({memberIds,canonicalDisplayId:memberIds.includes(input.canonicalDisplayId)?input.canonicalDisplayId:memberIds[0]??''})} label="选择自己使用的身份" query={input.memberQuery} onQuery={(memberQuery:string)=>change({memberQuery})} manual={input.memberManual} onManual={(memberManual:string)=>change({memberManual})} disabled={busy} includeSelf lockSelf={isCreate}/>
   <label>主要展示哪个身份？<select required value={input.canonicalDisplayId} disabled={busy} onChange={e=>change({canonicalDisplayId:e.target.value})}><option value="">选择主要展示身份</option>{input.memberIds.map((id:string)=><option key={id} value={id}>{display(id)}</option>)}</select></label>
   <fieldset className="ig-visibility"><legend>谁可以看到这个身份分组？</legend><label><input type="radio" name={key+'-visibility'} value="Private" checked={input.visibility==='Private'} disabled={busy} onChange={()=>change({visibility:'Private'})}/><span>仅这些身份及我指定的查看者</span></label><label><input type="radio" name={key+'-visibility'} value="Public" checked={input.visibility==='Public'} disabled={busy} onChange={()=>change({visibility:'Public'})}/><span>公开这份身份分组</span></label></fieldset>
   {input.visibility==='Private'&&<ReadingDetails mode="inline" open={!!input.viewers.length}><ReadingSummary>指定其他查看者（可选）</ReadingSummary><IdentityGroupPeoplePicker runtime={runtime} client={client} lease={lease} subjectId={subjectId} value={input.viewers} onChange={(viewers:string[])=>change({viewers})} label="额外查看者" query={input.viewerQuery} onQuery={(viewerQuery:string)=>change({viewerQuery})} manual={input.viewerManual} onManual={(viewerManual:string)=>change({viewerManual})} max={16} disabled={busy}/></ReadingDetails>}
   <IdentityGroupSources runtime={runtime} client={client} lease={lease} subjectId={subjectId} groupId={isCreate?null:initial.groupId} input={input} change={change} disabled={busy}/>
   <p className="permission-line">分组只改变身份和选定记录的共同展示。原作者、签名、能力、额度及记录权限都保留。其他受影响身份需在 24 小时内同意；修改获全部同意前，原分组继续有效。</p>
  </>}
  {changedGroup&&<section className="ig-version-change"><h4><output>当前分组已经更新</output></h4><p>目前共同展示的身份：{changedGroup.memberIds.map(display).join('、')}。</p><p>主要展示身份：{changedGroup.canonicalDisplayId?display(changedGroup.canonicalDisplayId):'当前未共同展示'}。{changedGroup.visibility==='Public'?'分组公开。':'分组仅向指定范围可见。'}</p><Button type="button" variant="outline" disabled={busy} onClick={()=>{change({expectedVersion:changedGroup.version,previousOperationId:changedGroup.operationId});setChangedGroup(null);}}>按当前分组继续我的输入</Button></section>}
  {error&&<p role="alert" className="message error">{error}</p>}{notice&&<output>{notice}</output>}<output className="muted ig-draft-status">{draft.status||'未提交的文字与选择会保存在本机。'}</output>
  <footer className="ig-form-actions"><Button type="submit" disabled={busy||!draft.ready||!!changedGroup||(!isRevoke&&input.memberIds.length<2)}>{busy?'正在处理…':isCreate?'发送分组邀请':isRevoke?'撤销整个分组':'发送修改邀请'}</Button><Button type="button" variant="ghost" onClick={onBack}>{busy?'离开此页':'返回'}</Button></footer>
 </form>;
}
