import React,{useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {Button} from '@/components/ui/button';
import {Textarea} from '@/components/ui/textarea';
import {ReadingDetails,ReadingSummary} from '../../../shared/reading/reading-details';
import {galaxyQueryKey} from '../../../shared/runtime/query-client';
import {useAccountSessionModel} from '../../accounts/account-session-scope';
import {sendAccountOperation} from './account-operation';
import {CommentReports} from './presentation';
import type {CommentReportView} from './task-comment-view-types';

type Kind='appeal'|'supplement';
type Report={reportId:string;taskId:string;target:{type:'task-comment';id:string;revision:number};version:number;state:string;reviewState:string|null;pauseUntil:string|null;events:{eventId:string;kind:string;summary:string}[];canAppeal:boolean;canSupplement:boolean};
type Page={items:Report[];next:string|null};
type ResponsePage={items:Report[];nextAfter:string|null};
type Payload={schemaVersion:2;id:string;reportId:string;expectedVersion:number;kind:Kind;summary:string};
type Saved={reportId:string;version:number;kind:Kind;text:string;pending:Payload|null};
const errorText=(reason:unknown)=>{const code=reason&&typeof reason==='object'&&'code'in reason?String(reason.code):'';return ({comment_governance_version_conflict:'处理状态已有变化，请重新查看。',comment_governance_transition:'当前处理状态不再允许这项操作。',comment_governance_event_limit:'这项处理记录已达到补充次数上限。',not_found:'该评论的处理记录当前不可读取。',official_account_session_expired:'登录已过期，请重新登录。'} as Record<string,string>)[code]??'暂时无法完成，请稍后重试。';};
export function AccountCommentGovernance({commentId,endpoint,onChanged}:{commentId:string;endpoint:string;onChanged:()=>void}){
 const account=useAccountSessionModel(),accountId=account.session?.account.id;
 if(!accountId||!account.client||!account.session||account.phase!=='signed-in')return null;
 return <AccountGovernanceSession key={accountId+':'+commentId} {...{commentId,endpoint,onChanged,accountId,account}}/>;
}
function AccountGovernanceSession({commentId,endpoint,onChanged,accountId,account}:{commentId:string;endpoint:string;onChanged:()=>void;accountId:string;account:ReturnType<typeof useAccountSessionModel>}){
 const [open,setOpen]=useState(false),[pages,setPages]=useState(1),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const queryClient=useQueryClient(),scope={endpoint,identity:accountId,surface:'web' as const};
 const prefix=galaxyQueryKey(scope,'tasks','account-comment-governance',commentId);
 const read=useQuery<Page,Error>({queryKey:[...prefix,pages],enabled:open,placeholderData:previous=>previous,queryFn:async({signal})=>{const items:Report[]=[];let after:string|undefined;for(let i=0;i<pages;i++){const page:ResponsePage=await account.client!.call('/v2/account-comment-governance/query',{commentId,limit:20,...(after?{after}:{})},{session:account.session!,signal});items.push(...page.items);if(!page.nextAfter)return {items,next:null};if(page.nextAfter===after)throw Error('invalid_cursor');after=page.nextAfter;}return {items,next:after??null};}});
 const key=`task-account-comment-governance:${endpoint}:${accountId}:${commentId}`;
 const [draft,setDraft]=useState<Saved|null>(()=>{try{const value=JSON.parse(localStorage.getItem(key)??'null');if(value&&typeof value.text==='string'&&typeof value.reportId==='string'&&['appeal','supplement'].includes(value.kind)&&(!value.pending||value.pending.reportId===value.reportId))return value;}catch{}return null;});
 const save=(value:Saved)=>{localStorage.setItem(key,JSON.stringify(value));setDraft(value);};
 const start=(kind:Kind,reportId:string)=>{if(draft){setMessage('请先完成当前说明。');return;}const report=read.data?.items.find(item=>item.reportId===reportId);if(!report||(kind==='appeal'?!report.canAppeal:!report.canSupplement))return;try{save({kind,reportId,version:report.version,text:'',pending:null});setMessage('');}catch{setMessage('无法保存草稿，请检查浏览器存储。');}};
 const finish=(payload:Payload,result:unknown)=>{if(!result||typeof result!=='object'||!('eventId'in result)||!('reportId'in result)||!('version'in result)||result.eventId!==payload.id||result.reportId!==payload.reportId||result.version!==payload.expectedVersion+1)throw Error('receipt_mismatch');localStorage.removeItem(key);setDraft(null);setMessage(payload.kind==='appeal'?'申诉已提交。':'说明已提交。');void queryClient.invalidateQueries({queryKey:prefix});onChanged();};
 const submit=async()=>{if(!draft||busy||!account.client||!account.session)return;setBusy(true);setMessage('');try{
  const payload:Payload=draft.pending??{schemaVersion:2,id:crypto.randomUUID(),reportId:draft.reportId,expectedVersion:draft.version,kind:draft.kind,summary:draft.text.trim()};
  if(!payload.summary)return;
  const result=await sendAccountOperation({pending:draft.pending,payload,call:(path,input)=>account.client!.call(path,input,{session:account.session!}),receiptPath:'/v2/account-comment-governance/receipt',eventPath:'/v2/account-comment-governance/events',remember:value=>save({...draft,pending:value}),release:()=>{save({...draft,pending:null});void queryClient.invalidateQueries({queryKey:prefix});},isAcknowledged:value=>!!value&&typeof value==='object'&&'state'in value&&value.state==='acknowledged'});finish(payload,result);
 }catch(reason){setMessage(errorText(reason));}finally{setBusy(false);}};
 const denied=read.error&&typeof read.error==='object'&&'code'in read.error&&['not_found','access_denied','official_account_session_expired'].includes(String(read.error.code));
 const reports:CommentReportView[]=(denied?[]:read.data?.items??[]).map(item=>({...item,source:null,decisionRecipients:[],canModerate:false,canReviewSource:false,canWithdrawReport:false,events:item.events.map(event=>({...event,authorId:'account:'+accountId}))}));
 return <ReadingDetails open={open} onOpenChange={setOpen}><ReadingSummary>查看处理情况</ReadingSummary><div className="discussion-reports">
  {read.isFetching&&!read.data&&<p>正在读取…</p>}{read.isError&&<p role="alert">{errorText(read.error)} <button className="text-link" onClick={()=>void read.refetch()}>重试</button></p>}
  {read.isSuccess&&!reports.length&&<p>暂无处理记录。</p>}
  <CommentReports reports={reports} busy={busy} person={()=>'我'} begin={()=>{}} onReadAndBegin={start}/>
  {!denied&&read.data?.next&&<Button variant="ghost" disabled={read.isFetching} onClick={()=>setPages(value=>value+1)}>更多记录</Button>}
  {draft&&<form className="discussion-editor workspace-form" onSubmit={event=>{event.preventDefault();void submit();}}><h3>{draft.kind==='appeal'?'提出申诉':'补充说明'}</h3><label>说明<Textarea maxLength={1600} value={draft.text} disabled={busy||!!draft.pending} onChange={event=>{try{save({...draft,text:event.target.value});}catch{setMessage('无法保存草稿，请检查浏览器存储。');}}}/></label><footer>{!draft.pending&&read.data?.items.some(item=>item.reportId===draft.reportId&&item.version!==draft.version&&(draft.kind==='appeal'?item.canAppeal:item.canSupplement))&&<Button type="button" variant="outline" onClick={()=>{const latest=read.data?.items.find(item=>item.reportId===draft.reportId);if(latest)save({...draft,version:latest.version});}}>使用最新处理状态</Button>}{!draft.pending&&<Button type="button" variant="ghost" onClick={()=>{localStorage.removeItem(key);setDraft(null);}}>取消</Button>}<Button type="submit" disabled={busy||(!draft.pending&&!draft.text.trim())}>{busy?'正在提交…':draft.pending?'重试':draft.kind==='appeal'?'提交申诉':'提交说明'}</Button></footer></form>}
  {message&&<p role="status">{message}</p>}
 </div></ReadingDetails>;
}
