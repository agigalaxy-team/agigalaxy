import { states, actions, Audience, CommentStream, CommentReports } from "./presentation";
import {ReadingDetails,ReadingSummary} from "../../../shared/reading/reading-details";
import React, { useCallback, useEffect, useEffectEvent, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { createTaskCommentClient } from './task-comment-client.mjs';
import { AccountVerificationPrompt, needsAccountVerification } from "../../accounts/account-verification-prompt";
import {MemberAvatar,memberName,useMemberNames} from "../../../shared/people/conversation-ui";
import {useGovernanceDraft} from "../../governance/governance-presentation";
import {useChoiceViewLease,type ChoiceViewLease} from "../../../shared/operations/choice-retained-operations";
import {assertPreparedComment,commentPermitted,commentReadingInitial,commentSubmission,type CommentProps,type CommentTask,type CommentView,type CommentTarget,type CommentReportView,type CommentReportTarget,type CommentKind,type CommentForm,type CommentSnapshot,type CommentDraft,type CommentReading,type CommentConfig,type CommentQuota,type CommentPending,type CommentPrepared,type CommentOriginal,type CommentContinuation,type CommentAuthorization,type CommentPreview,type CommentSourceChange,type CommentClient} from './task-comment-view-types';
import {MessageCircle,Pencil,Search,X} from 'lucide-react';
import './task-discussion.css';

type CommentConnection = Record<string, unknown> | null;
function commentConnectionCurrent(owner: CommentConnection, api: {endpoint: string; snapshot: () => CommentConnection}, connected: boolean) {
  if (!owner) return !connected;
  const next = api.snapshot();
  return api.endpoint === owner.endpoint && ['subjectId', 'bindingId', 'generation'].every(field => next?.[field] === owner[field]);
}
function arrangeLoadedComments(items:CommentView[]) {
  // The API cursor is an ID cursor, not a chronological position. Only reorder
  // returned records; never manufacture a parent, a timestamp, or another page.
  const entries=items.map((comment,index)=>{const stamp=Date.parse(comment.createdAt);return{comment,index,time:Number.isFinite(stamp)?stamp:Infinity};});
  entries.sort((a,b)=>a.time===b.time?a.index-b.index:a.time-b.time);
  const byId=new Map(entries.map(entry=>[entry.comment.commentId,entry])),added=new Set<string>(),visiting=new Set<string>(),ordered:CommentView[]=[];
  const append=(entry:typeof entries[number])=>{
    const id=entry.comment.commentId;if(added.has(id)||visiting.has(id))return;visiting.add(id);
    const parent=entry.comment.replyTo?byId.get(entry.comment.replyTo.id):undefined;
    // Service timestamps can share a second. Preserve their actual time while
    // showing a loaded original before its same-time reply.
    if(parent&&parent.time===entry.time)append(parent);
    visiting.delete(id);added.add(id);ordered.push(entry.comment);
  };
  entries.forEach(append);return ordered;
}
const emptyCommentForm = ():CommentForm => ({id: crypto.randomUUID(), revision: 0, editor: null, text: '', reason: '', audience: [], category: 'advertising', verdict: 'dismissed', disposition: 'unchanged', rule: 'comment-rules/1', pauseMinutes: 60, operationId: undefined});
// This component also renders for anonymous readers; put it outside the
// authenticated-only collaboration workbench in the Task detail page.
export function TaskCommentsWorkspace(props:CommentProps) {
  const scope=useChoiceViewLease(props.runtime,props.subjectId);
  return <TaskCommentsSession key={props.task.taskId+':'+scope.key+':'+props.connected} {...props} lease={scope.lease}/>;
}
function TaskCommentsSession({
  task,
  runtime,
  subjectId,
  connected,
  navigate,
  lease,
}: CommentProps&{lease:ChoiceViewLease|null}) {
  const taskId=task.taskId;
  const [taskView,setTaskView]=useState(task);
  const privateTask=taskView.request?.visibility==='Private';
  const client = useMemo<CommentClient|null>(
    () => {
      if(!connected)return null;
      const base=createTaskCommentClient({
            api: runtime.api,
            getLocal: runtime.getLocal,
            putLocal: runtime.putLocal,
            updateLocal: runtime.updateLocal,
            subjectId,
            taskId,
            receiptStatus: runtime.receiptStatus,
          });
      return {...base,prepare:async(type,payload,scope)=>{const operation=await base.prepare(type,payload,scope);assertPreparedComment(operation);return operation;}};
    },
    [runtime, subjectId, taskId, connected],
  );
  const [comments, setComments] = useState<CommentView[]>([]),
    [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [pending, setPending] = useState<CommentPending[]>([]),
    [quota, setQuota] = useState<CommentQuota|null>(null),
    [config, setConfig] = useState<CommentConfig|null>(null);
  const [reports, setReports] = useState<CommentReportView[]>([]),
    [reportNext, setReportNext] = useState<string | null>(null);
  const committedRef = useRef(false), busyRef = useRef(false);
  const activeRef = useRef(true);
  const [owner] = useState<CommentConnection>(() => connected ? { ...runtime.api.snapshot(), endpoint: runtime.api.endpoint } : null);
  const current = useCallback(() => {if(!activeRef.current||!commentConnectionCurrent(owner,runtime.api,connected))return false;try{if(connected){if(!lease)return false;lease.assertCurrent();}return true;}catch{return false;}}, [owner,runtime,connected,lease]);
  const permitted=useCallback((kind:string|undefined,comment?:CommentTarget|null,report?:CommentReportTarget|null)=>commentPermitted(kind,comment,report,subjectId),[subjectId]);
  const [form, setForm] = useState(emptyCommentForm);
  const formRef = useRef(form);
  const {editor, text, reason, audience, category, verdict, disposition, rule, pauseMinutes} = form;
  const [preview, setPreview] = useState<CommentPreview|null>(null);
  const [draftState, setDraftState] = useState(connected ? 'loading' : 'ready');
  const [draftMessage, setDraftMessage] = useState('');
  const [verificationRequired, setVerificationRequired] = useState(false);
  const draftRead = useRef(0), lastSavedDraft = useRef('');
  const retainedDraft = useRef<{id: string; revision: number; operationId?: string} | null>(null);
  const [hasRetainedDraft, setHasRetainedDraft] = useState(false);
  function changeForm(patch: Partial<typeof form>) {
    if (!current() || draftState !== 'ready') return;
    const next = {...formRef.current, operationId: undefined, ...patch, revision: formRef.current.revision + 1};
    formRef.current = next; setForm(next);
    void saveDraft(next).catch(() => { if (current()) setDraftMessage('本机草稿尚未保存，请保持此页并重试保存后再离开。'); });
  }
  const setText = (value: string) => changeForm({text: value});
  const setReason = (value: string) => changeForm({reason: value});
  const setAudience = (value: string[]) => changeForm({audience: value});
  const setCategory = (value: string) => {if(value==='advertising'||value==='harassment'||value==='privacy'||value==='review-request'||value==='other')changeForm({category:value});};
  const setVerdict = (value: string) => {if(value==='upheld'||value==='dismissed')changeForm({verdict:value});};
  const setDisposition = (value: string) => {if(value==='unchanged'||value==='approve'||value==='reject')changeForm({disposition:value});};
  const setRule = (value: string) => changeForm({rule: value});
  const setPauseMinutes = (value: number) => changeForm({pauseMinutes: value});
  const draftFrom = useCallback((value = formRef.current):CommentDraft|null => {
    if (!value.editor) return null;
    return {id: value.id, revision: value.revision, kind: value.editor.kind, text: value.text, reason: value.reason, audience: value.audience,
      category: value.category, verdict: value.verdict, disposition: value.disposition, rule: value.rule, pauseMinutes: value.pauseMinutes,
      ...(value.editor.comment ? {commentRef: {commentId: value.editor.comment.commentId, revision: value.editor.comment.revision}} : {}),
      ...(value.editor.report ? {reportRef: {id: value.editor.report.reportId, version: value.editor.report.version}} : {}),
      ...(value.operationId ? {operationId: value.operationId} : {})};
  }, []);
  async function saveDraft(value = formRef.current) {
    const draft = draftFrom(value);
    if (!client || !draft || draftState !== 'ready' || !current()) return;
    const encoded = JSON.stringify(draft);
    if (encoded !== lastSavedDraft.current) {
      await client.draft.save(draft);
      if (!current()) return;
      lastSavedDraft.current = encoded; retainedDraft.current = {id: draft.id, revision: draft.revision, operationId: draft.operationId}; setHasRetainedDraft(true);
    }
    await client.draft.flush();
    if (current() && formRef.current.id === draft.id && formRef.current.revision === draft.revision) setDraftMessage('本机草稿已保存，不会自动发送。');
  }
  const local = useCallback(async () => {
    if (client) { const values = await client.pending(); if (current()) setPending(values); }
  }, [client, current]);
  const restoreDraft = useCallback(async () => {
    if (!client || !current()) return;
    const ticket = ++draftRead.current;
    const formAtRead = formRef.current;
    setDraftState('loading'); setDraftMessage('正在核对当前任务与本机草稿…');
    try {
      const draft = await client.draft.load();
      if (!current() || ticket !== draftRead.current) return;
      // A newer local edit or completion owns its form and save status.
      if (formRef.current !== formAtRead) { setDraftState('ready'); return; }
      retainedDraft.current = draft ? {id: draft.id, revision: draft.revision, operationId: draft.operationId} : null;
      setHasRetainedDraft(!!draft);
      if (draft?.operationId) {
        let result;
        try { result = await client.reconcile(draft.operationId); }
        catch { throw new Error('草稿所指的原操作暂不能核对。原记录仍保留，请先重新查询，不能把它当作新的未发送评论。'); }
        if (!current() || ticket !== draftRead.current) return;
        if (result.state === 'acknowledged') {
          const removed = await client.draft.clear({id: draft.id, revision: draft.revision});
          if (!current() || ticket !== draftRead.current) return;
          if (!removed) throw new Error('草稿所指的本机版本已在另一页面改变，请重新核对。');
          const cleared = emptyCommentForm(); formRef.current = cleared; setForm(cleared); setPreview(null);
          lastSavedDraft.current = ''; retainedDraft.current = null; setHasRetainedDraft(false); setDraftState('ready');
          setDraftMessage('原操作已确认，已清除对应的已发送草稿。评论是否可见以当前服务状态为准。');
          await local(); return;
        }
      }
      let comment:CommentTarget|undefined,report:CommentReportTarget|undefined,freshComment:CommentView|null|undefined,changedTarget:CommentSourceChange|undefined;
      if (draft?.commentRef) {
        // The saved text belongs to this author. An unavailable foreign source
        // blocks sending, not the recovery of that text or its original locator.
        comment = {commentId: draft.commentRef.commentId, taskId, revision: draft.commentRef.revision, currentRevision: draft.commentRef.revision};
        try { freshComment = await runtime.api.call('/v2/comments/' + draft.commentRef.commentId, undefined, {method: 'GET'}); }
        catch { freshComment = null; }
        if (!current() || ticket !== draftRead.current) return;
        if (freshComment?.taskId !== taskId || freshComment?.commentId !== draft.commentRef.commentId) freshComment = null;
        if (freshComment && freshComment.revision === draft.commentRef.revision && freshComment.currentRevision === draft.commentRef.revision && permitted(draft.kind, freshComment, null)) comment = freshComment;
        else {
          const nextKind = draft.kind === 'edit' && !freshComment?.canEdit && freshComment?.canCorrect ? 'correct' : draft.kind;
          changedTarget = {kind: 'comment', source: freshComment, nextKind, canContinue: !!freshComment && permitted(nextKind, freshComment, null)};
        }
      }
      if (draft?.reportRef) {
        report = {reportId: draft.reportRef.id, taskId, version: draft.reportRef.version};
        let freshReport;
        try { freshReport = await client.report(draft.reportRef.id); }
        catch { freshReport = null; }
        if (!current() || ticket !== draftRead.current) return;
        if (freshReport?.taskId !== taskId || freshReport?.reportId !== draft.reportRef.id) freshReport = null;
        if (freshReport && freshReport.version === draft.reportRef.version && permitted(draft.kind, null, freshReport)) report = freshReport;
        else changedTarget = {kind: 'report', source: freshReport, canContinue: !!freshReport && permitted(draft.kind, null, freshReport)};
      }
      if (!current() || ticket !== draftRead.current) return;
      if (draft) {
        const restored = {...emptyCommentForm(), ...draft, editor: {kind: draft.kind, comment, report}};
        formRef.current = restored; setForm(restored); setReplyFresh(freshComment??null); lastSavedDraft.current = JSON.stringify(draftFrom(restored));
        setSourceChange(changedTarget??null);
        setDraftMessage(changedTarget ? '已恢复你的输入。原目标需要重新核对；不会自动发送。' : '已恢复本机草稿。请核对原目标和内容后继续；不会自动发送。');
      } else {
        const cleared = emptyCommentForm(); formRef.current = cleared; setForm(cleared); setPreview(null);
        lastSavedDraft.current = ''; setDraftMessage('');
      }
      setDraftState('ready');
    } catch (cause) {
      if (!current() || ticket !== draftRead.current) return;
      setDraftState('unavailable');
      setDraftMessage(cause instanceof Error && cause.message.startsWith('草稿所指') ? cause.message : '本机草稿暂不能读取。请先核对当前任务的查看权限，再重新读取；原稿不会被覆盖。');
    }
  }, [client,current,draftFrom,local,runtime,taskId,permitted]);
  async function discardDraft() {
    if (!client || !current()) return;
    await client.draft.flush();
    const expected = retainedDraft.current ?? draftFrom();
    if (expected && !await client.draft.clear({id: expected.id, revision: expected.revision})) throw new Error('本机草稿已有新版本，请重新读取后再处理。');
    if (!current()) return;
    const cleared = emptyCommentForm(); formRef.current = cleared; setForm(cleared); setPreview(null); setDraftState('ready'); setDraftMessage(''); lastSavedDraft.current = ''; retainedDraft.current = null; setHasRetainedDraft(false);
  }
  async function completeDraft(operationId: string) {
    const expected = formRef.current.operationId === operationId ? formRef.current : retainedDraft.current?.operationId === operationId ? retainedDraft.current : null;
    if (!client || !current() || !expected) return;
    await client.draft.flush();
    const cleared = await client.draft.clear({id: expected.id, revision: expected.revision});
    if (!current() || !cleared) return;
    if (retainedDraft.current?.id === expected.id && retainedDraft.current.revision === expected.revision) { retainedDraft.current = null; setHasRetainedDraft(false); }
    if (formRef.current.editor && (formRef.current.id !== expected.id || formRef.current.revision !== expected.revision)) return;
    const next = emptyCommentForm(); formRef.current = next; setForm(next); setPreview(null); setDraftState('ready'); setDraftMessage(''); lastSavedDraft.current = '';
  }
  const readingInitial=commentReadingInitial;
  const readingDraft=useGovernanceDraft(runtime,subjectId,!!lease,'comment-reading:v1:'+JSON.stringify([runtime.api.endpoint,subjectId??null,taskId]),readingInitial);
  const reading=useMemo(()=>({...readingInitial,...readingDraft.value}),[readingInitial,readingDraft.value]),query=reading.query,reportOpen=reading.reportOpen,reportComment=reading.reportComment;
  const readingRef=useRef(reading);useLayoutEffect(()=>{readingRef.current=reading;},[reading]);
  const [loading,setLoading]=useState(true),[menu,setMenu]=useState<string|null>(null),[replyFresh,setReplyFresh]=useState<CommentTarget|null>(null),[sourceChange,setSourceChange]=useState<CommentSourceChange|null>(null);
  const [now,setNow]=useState(Date.now),fieldId=useId();
  const [postedComment,setPostedComment]=useState<string|null>(null);
  const [pendingChecks,setPendingChecks]=useState<Record<string,CommentContinuation>>({});
  const stoppedOffset=useRef(0);
  const initialized=useRef(false),readSequence=useRef(0),checking=useRef(false);
  const editorElement=useRef<HTMLFormElement>(null),dialog=useRef<HTMLDialogElement>(null),changeDialog=useRef<HTMLDialogElement>(null),reportsElement=useRef<HTMLElement>(null),previewRef=useRef(preview);
  useLayoutEffect(()=>{previewRef.current=preview;},[preview]);
  function readingChange(patch:Partial<CommentReading>){readingRef.current={...readingRef.current,...patch};readingDraft.change(patch);}
  const knownPeople=[...new Set([taskView.requesterId,...(taskView.participations??[]).map((p)=>p.subjectId),...comments.map((c)=>c.authorId),...(editor?.comment?.authorId?[editor.comment.authorId]:[]),...audience])].filter((id):id is string=>typeof id==='string'&&id!==subjectId);
  const names=useMemberNames(runtime,subjectId,connected,[subjectId,...knownPeople,...(config?.moderatorIds??[]),...reports.flatMap((report)=>[...(report.decisionRecipients??[]),...(report.events??[]).map((event)=>event.authorId)]),...(preview?.kind==='prepared'?preview.operation.viewers:[]),...(preview?.kind==='recovery'||preview?.kind==='stop-original'?preview.record.viewers:[])]);
  const person=(id:string)=>memberName(id,subjectId,names[id]??undefined);
  const governanceAction=editor&&!['create','edit','correct','retract'].includes(editor.kind),modAction=editor&&['pause','resume','resolve'].includes(editor.kind);
  const allowedAudience=governanceAction?modAction?(editor?.report?.decisionRecipients??[]):(config?.moderatorIds??[]).filter((id:string)=>id!==subjectId):knownPeople;
  const availableAudience=[...new Set([...allowedAudience,...audience])];
  const commentQuota=quota?.quotas?.find((value)=>value.category==='comment'),quotaBlocked=!privateTask&&editor?.kind==='create'&&commentQuota?.remaining===0&&(!commentQuota.resetAt||Date.parse(commentQuota.resetAt)>now);
  function friendlyError(cause:unknown){
    const code=cause&&typeof cause==='object'&&'code' in cause&&typeof cause.code==='string'?cause.code:'',message=cause&&typeof cause==='object'&&'message' in cause&&typeof cause.message==='string'?cause.message:'';
    const key=code||message,known:Record<string,string>={comment_revision_conflict:'这条评论已有更新。你的文字已保留，请先查看当前内容。',comment_reply_unavailable:'原回复对象已经变化或无法读取。你的文字已保留，请重新选择回复对象。',comment_report_version_conflict:'评论已更新，请按当前内容重新选择需要处理的版本。',comment_visibility_mismatch:'任务或接收人的可见范围已变化，请核对后再发送。',comment_expired:'这条评论已过保留期，不能继续修改。',comment_edit_window_closed:'这条评论已过可直接修改的时间，可以追加更正。',comment_retracted:'这条评论已经撤回，不能继续修改。',community_quota_exceeded:'今天可发布的公开评论已用完，输入已保留。',community_cooldown:'评论发送较密，请稍后继续；输入已保留。',community_restricted:'当前账号暂时不能发布评论，输入已保留。',not_found:'当前任务或所选内容已无法读取。',invalid_comment_query:'检索内容无法读取，请缩短关键词后重试。'};
    return known[key]??(/[\u3400-\u9fff]/.test(message)?message:'暂时未能完成，已输入的内容仍保留。');
  }
  async function read(options:{query?:string;pages?:number}={}){
    const sequence=++readSequence.current,selectedQuery=options.query??readingRef.current.submittedQuery,pages=options.pages??readingRef.current.pages,items:CommentView[]=[];let after:string|undefined,more:string|null=null;
    try{
      for(let page=0;page<Math.max(1,pages);page++){
        const value:{items:CommentView[];nextAfter:string|null}=await runtime.api.call('/v2/comments/query',{taskId,query:selectedQuery,...(after?{after}:{}),limit:20},{authenticated:!!connected});
        if(!current()||sequence!==readSequence.current)return;
        for(const item of value.items)if(!items.some(old=>old.commentId===item.commentId))items.push(item);more=value.nextAfter??null;if(!more)break;if(more===after)throw Error('评论分页暂时无法继续，请稍后重试。');after=more;
      }
      if(!current()||sequence!==readSequence.current)return;
      const ordered=arrangeLoadedComments(items);setComments(ordered);setNext(more);
      const target=formRef.current.editor?.comment;
      if(target){let fresh:CommentView|null|undefined=items.find(item=>item.commentId===target.commentId);if(!fresh&&client)try{fresh=await client.get(target.commentId);}catch{fresh=null;}if(current()&&sequence===readSequence.current){setReplyFresh(fresh??null);setSourceChange((old)=>old?.kind==='comment'?{...old,source:fresh??null,canContinue:!!fresh&&fresh.taskId===taskId&&permitted(old.nextKind??formRef.current.editor?.kind,fresh,null)}:old);}}
      const reportTarget=formRef.current.editor?.report;
      if(reportTarget&&client){let fresh;try{fresh=await client.report(reportTarget.reportId);}catch{fresh=null;}if(fresh?.taskId!==taskId)fresh=null;if(current()&&sequence===readSequence.current)setSourceChange((old)=>old?.kind==='report'?{...old,source:fresh,canContinue:!!fresh&&permitted(formRef.current.editor?.kind,null,fresh)}:old);}
      return{items:ordered,next:more,query:selectedQuery};
    }catch(cause){if(current()&&sequence===readSequence.current){setComments([]);setNext(null);setReplyFresh(null);setSourceChange((old)=>old&&(old.kind==='comment'||old.kind==='report')?{...old,source:null,canContinue:false}:old);}throw cause;}finally{if(current()&&sequence===readSequence.current)setLoading(false);}
  }
  const extras=useCallback(async()=>{
    if(!client)return;
    const results=await Promise.allSettled([client.governanceConfig(),runtime.api.call('/v2/account/quotas',{}),client.pending()]);
    if(!current())return;
    if(results[0].status==='fulfilled')setConfig(results[0].value);else setConfig({unavailable:true});
    if(results[1].status==='fulfilled')setQuota(results[1].value);else setQuota({unavailable:true});
    if(results[2].status==='fulfilled')setPending(results[2].value);
  },[client,current,runtime]);
  async function checkPending(){
    if(!client||!current())return false;const originals=await client.pending();if(!current())return false;let changed=false;
    const stopped=originals.filter(item=>item.state==='stopped-local'),start=stopped.length?stoppedOffset.current%stopped.length:0;
    const visible=[...originals.filter(item=>item.state!=='stopped-local'),...stopped.slice(start,start+4)];stoppedOffset.current=start+4;
    for(const original of visible){
      try{
        let result=await client.reconcile(original.operationId);if(!current())return changed;
        if(result.state!=='acknowledged'&&original.state!=='stopped-local'&&!((previewRef.current?.kind==='recovery'||previewRef.current?.kind==='stop-original')&&previewRef.current.record.operationId===original.operationId)){
          const review=await client.reviewPending(original.operationId);if(!current())return changed;
          const target=await recoveryTarget(review);if(!current())return changed;
          if(target.state==='ready'){result=await client.resumePending(original.operationId);if(!current())return changed;setPendingChecks(old=>({...old,[original.operationId]:result}));}
          else setPendingChecks(old=>({...old,[original.operationId]:target}));
        }
        if(result.state==='acknowledged'){changed=true;await completeDraft(original.operationId);if(!current())return changed;if(previewRef.current?.kind==='recovery'&&previewRef.current.record.operationId===original.operationId)setPreview(null);if(formRef.current.editor&&formRef.current.operationId!==original.operationId)setNotice('上次的内容已发送，当前草稿仍保留，尚未发送。');}
      }catch{/* Keep the exact original locator; a later read can settle it. */}
    }
    if(current())await local();return changed;
  }
  async function run(fn:()=>Promise<unknown>){
    if(busyRef.current||!current())return;busyRef.current=true;setBusy(true);setError('');setNotice('');committedRef.current=false;
    try{await fn();}catch(cause){
      if(!current())return;setPreview(null);const required=needsAccountVerification(cause);setVerificationRequired(required);
      setError(committedRef.current?'内容已发送，列表稍后会自动更新。':required?'发送前需要关联银河账户。你的文字会保留。':friendlyError(cause));
    }finally{try{await local();}catch{}busyRef.current=false;if(current())setBusy(false);}
  }
  const checkLatest=useEffectEvent(async()=>{
    if(checking.current||busyRef.current||document.hidden||!current()||!initialized.current)return;checking.current=true;
    try{await checkPending();if(!current())return;await read();if(current()&&reportOpen)await loadReports(reportComment??undefined,readingRef.current.reportPages);if(current())setError('');}
    catch(cause){if(current())setError(friendlyError(cause));}finally{checking.current=false;}
  });
  const initialize=useEffectEvent(async()=>{
    try{await read();}catch(cause){if(current())setError(friendlyError(cause));}
    if(client&&current())try{await extras();if(current())await restoreDraft();if(current())await checkPending();}catch(cause){if(current())setError(friendlyError(cause));}
    if(current()&&readingRef.current.reportOpen)try{await loadReports(readingRef.current.reportComment??undefined,readingRef.current.reportPages);}catch(cause){if(current())setError(friendlyError(cause));}
  });
  useEffect(()=>{
    const active=activeRef,sequence=readSequence;active.current=true;
    if(!readingDraft.ready)return()=>{active.current=false;sequence.current++;};
    if(!initialized.current){initialized.current=true;void initialize();}
    const timer=window.setInterval(()=>{setNow(Date.now());void checkLatest();},15000),quotaTimer=window.setInterval(()=>{if(!document.hidden&&!busyRef.current&&current())void extras();},60000),visible=()=>{if(!document.hidden){setNow(Date.now());void checkLatest();}};document.addEventListener('visibilitychange',visible);
    return()=>{active.current=false;sequence.current++;window.clearInterval(timer);window.clearInterval(quotaTimer);document.removeEventListener('visibilitychange',visible);};
  },[current,extras,readingDraft.ready]);
  const previewOpen=preview!==null,sourceChangeOpen=sourceChange!==null,editorOpen=editor!==null;
  useEffect(()=>{if(previewOpen)dialog.current?.showModal();else dialog.current?.close();},[previewOpen]);
  useEffect(()=>{if(sourceChangeOpen)changeDialog.current?.showModal();else changeDialog.current?.close();},[sourceChangeOpen]);
  useEffect(()=>{if(!postedComment)return;const frame=requestAnimationFrame(()=>{document.getElementById('comment-'+postedComment)?.scrollIntoView({block:'center'});setPostedComment(null);});return()=>cancelAnimationFrame(frame);},[postedComment]);
  useEffect(()=>{if(!editorOpen)return;const frame=requestAnimationFrame(()=>{editorElement.current?.scrollIntoView({block:'center'});editorElement.current?.querySelector<HTMLElement>('textarea,input')?.focus({preventScroll:true});});return()=>cancelAnimationFrame(frame);},[form.id,editorOpen]);
  function beginNow(kind:CommentKind,comment?:CommentTarget,report?:CommentReportTarget){
    if(!current()||draftState!=='ready')return;setPreview(null);setMenu(null);setSourceChange(null);setReplyFresh(comment??null);
    const old=formRef.current,sameReplyDraft=kind==='create'&&old.editor?.kind==='create'&&!old.operationId;
    const next:CommentForm={...emptyCommentForm(),...(sameReplyDraft?{id:old.id,revision:old.revision,text:old.text,audience:old.audience}:{}),revision:(sameReplyDraft?old.revision:0)+1,editor:{kind,comment,report},text:sameReplyDraft?old.text:['edit','correct'].includes(kind)?comment?.body??'':'',
      category:comment?.state==='pending-review'?'review-request':'advertising',
      audience:sameReplyDraft?old.audience:kind==='retract'?[]:report?['pause','resume','resolve'].includes(kind)?report.decisionRecipients??[]:config?.moderatorIds??[]:kind==='report'?config?.moderatorIds??[]:privateTask?[...new Set([taskView.requesterId,comment?.authorId])].filter((id):id is string=>typeof id==='string'&&id!==subjectId):[]};
    formRef.current=next;setForm(next);void saveDraft(next).catch(()=>{if(current())setDraftMessage('本机草稿尚未保存，请保持此页并重试保存后再离开。');});
    requestAnimationFrame(()=>{editorElement.current?.scrollIntoView({block:'center'});editorElement.current?.querySelector<HTMLElement>('textarea,input')?.focus({preventScroll:true});});
  }
  function begin(kind:CommentKind,comment?:CommentTarget,report?:CommentReportTarget){
    if(!current()||busy||draftState!=='ready')return;readingChange({reportOpen:false});
    const old=formRef.current,same=old.editor?.kind===kind&&old.editor?.comment?.commentId===comment?.commentId&&old.editor?.report?.reportId===report?.reportId;
    if(same){editorElement.current?.scrollIntoView({block:'center'});editorElement.current?.querySelector<HTMLElement>('textarea,input')?.focus({preventScroll:true});setMenu(null);return;}
    if(old.editor&&(old.text.trim()||old.reason.trim()||old.operationId)&&!(kind==='create'&&old.editor.kind==='create'&&!old.operationId)){setMenu(null);setPreview({kind:'replace-draft',next:{kind,comment,report}});return;}
    beginNow(kind,comment,report);
  }
  async function loadReports(commentId?:string,pages=1){
    if(!client)return;const items:CommentReportView[]=[];let after:string|undefined,more:string|null=null,truncated=false;
    try{for(let page=0;page<Math.max(1,pages);page++){
      const value=await client.reports({...(commentId?{commentId}:{}),...(after?{after}:{}),limit:10});if(!current())return;
      items.push(...value.items.filter((row)=>row.taskId===taskId&&!items.some(old=>old.reportId===row.reportId)));more=value.nextAfter??null;truncated ||=!!value.scanTruncated;if(!more)break;if(more===after)throw Error('处理记录暂时无法继续读取。');after=more;
    }}catch(cause){if(current()){setReports([]);setReportNext(null);}throw cause;}
    if(!current())return;setReports(items);setReportNext(more);readingChange({reportOpen:true,reportComment:commentId??null,reportPages:pages});
    if(truncated)setNotice('可以从具体评论打开相关处理记录。');
  }
  async function openReports(commentId?:string){setMenu(null);await loadReports(commentId,1);}
  async function validateTarget(snapshot:CommentSnapshot){
    const freshTask:CommentTask=await runtime.api.call('/v2/tasks/'+taskId,undefined,{method:'GET'});if(!current())return false;
    if((freshTask.request?.visibility==='Private')!==privateTask){setSourceChange({kind:'task',task:freshTask,canContinue:true});return false;}
    const {kind,comment,report}=snapshot.editor;let currentReport:CommentReportView|undefined;
    if(comment){
      let fresh;try{fresh=await client!.get(comment.commentId);}catch{if(current()){setReplyFresh(null);setSourceChange({kind:'comment',source:null,canContinue:false});}return false;}
      if(!current())return false;setReplyFresh(fresh);
      if(fresh.taskId!==taskId||fresh.revision!==comment.revision||fresh.currentRevision!==comment.revision||!permitted(kind,fresh,null)){const nextKind=kind==='edit'&&!fresh.canEdit&&fresh.canCorrect?'correct':kind;setSourceChange({kind:'comment',source:fresh,nextKind,canContinue:fresh.taskId===taskId&&permitted(nextKind,fresh,null)});return false;}
    }
    if(report){
      let fresh;try{fresh=await client!.report(report.reportId);}catch{if(current())setSourceChange({kind:'report',source:null,canContinue:false});return false;}
      if(!current())return false;
      if(fresh.taskId!==taskId||fresh.version!==report.version||!permitted(kind,null,fresh)){setSourceChange({kind:'report',source:fresh,canContinue:fresh.taskId===taskId&&permitted(kind,null,fresh)});return false;}
      currentReport=fresh;
    }
    if(!['create','edit','correct','retract'].includes(kind)){
      const freshConfig=await client!.governanceConfig();if(!current())return false;setConfig(freshConfig);
      const recipients=['pause','resume','resolve'].includes(kind)?currentReport?.decisionRecipients??[]:freshConfig.moderatorIds??[];
      if(snapshot.audience.some((id:string)=>id!==subjectId&&!recipients.includes(id))){if(currentReport)setSourceChange({kind:'report',source:currentReport,canContinue:permitted(kind,null,currentReport)});setError('可接收这份说明的人员已变化，请核对所选人员后继续。');return false;}
    }
    return true;
  }
  async function executePrepared(operation:CommentPrepared,snapshot:CommentSnapshot){
    if(!client||!current())return;
    if(operation.payload.kind==='pause'&&(operation.payload.until??0)<=Math.floor(Date.now()/1000))throw Error('这次暂停的截止时间已经过去，请返回编辑后重新预览。');
    if(formRef.current.id!==snapshot.id||formRef.current.revision!==snapshot.revision)throw Error('你已修改当前文字，请按最新内容继续发送。');
    const submitted={...formRef.current,revision:formRef.current.revision+1,operationId:operation.operationId};formRef.current=submitted;setForm(submitted);await saveDraft(submitted);if(!current())return;
    const result=await client.execute(operation,{confirmed:true});if(!current())return;
    if(result.state!=='acknowledged')throw Error('正在确认这次发送，原内容已保留。');
    committedRef.current=true;await completeDraft(operation.operationId);if(!current())return;setPreview(null);
    setNotice(operation.type==='comment'?operation.payload.kind==='retract'?'评论已撤回。':operation.payload.kind==='create'?'评论已发送。':'评论已更新。':'说明已发送。');
    const refreshed=await read();if(!current())return;
    if(operation.type==='comment'&&operation.payload.kind==='create'&&refreshed){
      if(refreshed.items.some(item=>item.commentId===operation.payload.commentId))setPostedComment(operation.payload.commentId??null);
      else setNotice(refreshed.query?'评论已发送。当前查找条件下未显示这条评论。':refreshed.next?'评论已发送。这条评论不在当前已加载的部分，可继续加载查看。':'评论已发送，当前列表暂未显示这条评论。');
    }
    await extras();if(reportOpen)await loadReports(reportComment??undefined,readingRef.current.reportPages);
  }
  async function prepare(){
    if(!client||!formRef.current.editor||!current()||draftState!=='ready')return;
    const snapshot:CommentSnapshot=structuredClone({...formRef.current,editor:formRef.current.editor});await saveDraft(snapshot);if(!current())return;
    const originals=await client.pending();if(!current())return;
    if(originals.some((record)=>record.state==='awaiting-receipt')){setPending(originals);throw Error('上一次发送还在确认，当前文字已保留。可以先查看原内容。');}
    if(!await validateTarget(snapshot)||!current())return;
    if(formRef.current.id!==snapshot.id||formRef.current.revision!==snapshot.revision)throw Error('你刚才修改了内容，请按最新文字继续发送。');
    const {kind}=snapshot.editor,{type,payload,visibility}=commentSubmission(snapshot,taskId,privateTask,Date.now());
    const operation=await client.prepare(type,payload,{visibility,viewers:visibility==='Private'?snapshot.audience:[]});if(!current())return;
    if(type==='comment'&&kind!=='retract')await executePrepared(operation,snapshot);else setPreview({kind:'prepared',operation,snapshot});
  }
  function continuationMessage(value:CommentContinuation|CommentPending|CommentAuthorization|null|undefined){
    if(value?.message)return value.message;
    const time=value?.retryAt?new Date(value.retryAt).toLocaleString('zh-CN'):null;
    if(value?.reason==='quota-wait')return time?'公开评论额度已用完，可在 '+time+' 后继续。':'公开评论额度暂未恢复，原内容仍保留。';
    if(value?.reason==='cooldown-wait')return time?'这次发送需要等待至 '+time+'。':'这次发送暂时受限，原内容仍保留。';
    if(value?.reason==='original-rejected')return '这次内容不能按原条件发送。原内容保留，可以查看后停止这次发送。';
    if(value?.conditionUnavailable)return '暂时未能读取发送条件，原内容仍保留。';
    if(value?.state==='unconfirmed'||value?.blockedReason)return '请查看原内容、接收人和期限，再确认是否继续。';
    return '原内容会保留，当前编辑稿可以继续修改。';
  }
  async function recoveryTarget(review:CommentOriginal):Promise<CommentContinuation>{
    if(!client||!current())return{state:'waiting',message:'身份或连接已变化，请重新打开当前任务。'};
    const payload=review.payload,kind=payload.kind??'report';
    if(kind==='pause'&&(payload.until??0)<=Math.floor(Date.now()/1000))return{state:'changed',message:'原来的暂停截止时间已过，不能按这次操作继续发送。'};
    try{
      if(review.type==='governance'){
        if(!payload.reportId)return{state:'changed',message:'原处理记录缺少准确目标，请重新核对原操作。'};
        const report=await client.report(payload.reportId);if(!current())return{state:'waiting'};
        if(report.taskId!==taskId||report.version!==payload.expectedVersion||!permitted(kind,null,report))return{state:'changed',message:'原处理记录或处理权限已变化，这次原操作不能继续发送。'};
        const config=await client.governanceConfig();if(!current())return{state:'waiting'};
        const recipients=['pause','resume','resolve'].includes(kind)?report.decisionRecipients??[]:config.moderatorIds??[];
        if(review.viewers.some((id:string)=>id!==subjectId&&!recipients.includes(id)))return{state:'changed',message:'原接收人员的权限已变化，这次操作仍保留原范围，不能直接继续。'};
      }else{
        const currentTask:CommentTask=await runtime.api.call('/v2/tasks/'+taskId,undefined,{method:'GET'});if(!current())return{state:'waiting'};
        if(review.type==='comment'&&kind!=='retract'&&(currentTask.request?.visibility==='Private'?'Private':'Public')!==review.visibility)return{state:'changed',message:'任务的可见范围已改变，这次原操作不能继续发送。'};
        const commentId=review.type==='report'?payload.target?.id:kind==='create'?payload.replyTo?.id:payload.commentId;
        if(commentId){
          const comment=await client.get(commentId);if(!current())return{state:'waiting'};
          const version=review.type==='report'?payload.target?.revision:kind==='create'?payload.replyTo?.revision:payload.expectedRevision;
          if(comment.taskId!==taskId||comment.revision!==version||comment.currentRevision!==version||!permitted(review.type==='report'?'report':kind,comment,null))return{state:'changed',message:'原评论版本或权限已经变化。这次操作不会自动改为针对新版本。'};
        }
        if(review.type==='report'){
          const config=await client.governanceConfig();if(!current())return{state:'waiting'};
          if(review.viewers.some((id:string)=>id!==subjectId&&!(config.moderatorIds??[]).includes(id)))return{state:'changed',message:'原处理者名单已变化，这次说明不能直接继续发送。'};
        }
      }
      return{state:'ready'};
    }catch{return{state:'waiting',message:'暂时未能读取原目标的当前状态，内容会保留并稍后再核对。'};}
  }
  async function settleRecovered(operationId:string){
    await completeDraft(operationId);if(!current())return;setPreview(null);setNotice(formRef.current.editor?'上次的内容已发送，当前草稿仍保留，尚未发送。':'上次的内容已发送。');await local();await read();if(reportOpen)await loadReports(reportComment??undefined,readingRef.current.reportPages);
  }
  async function openRecovery(record:Pick<CommentPending,'operationId'>){
    const result=await client!.reconcile(record.operationId);if(!current())return;
    if(result.state==='acknowledged'){await settleRecovered(record.operationId);return;}
    const review=await client!.reviewPending(record.operationId);if(!current())return;
    const target=await recoveryTarget(review);if(!current())return;
    if(target.state!=='ready'){setPendingChecks(old=>({...old,[record.operationId]:target}));setPreview({kind:'recovery',record:review,target,authorization:null});return;}
    const authorization=await client!.reviewAuthorization(record.operationId);if(!current())return;
    if(authorization.state==='acknowledged'){await settleRecovered(record.operationId);return;}
    if(authorization.state==='reuse-original-authorization'){
      const resumed=await client!.resumePending(record.operationId);if(!current())return;
      if(resumed.state==='acknowledged'){await settleRecovered(record.operationId);return;}
      setPendingChecks(old=>({...old,[record.operationId]:resumed}));setPreview({kind:'recovery',record:review,target,authorization:resumed});return;
    }
    if(authorization.state==='unconfirmed')setPendingChecks(old=>({...old,[record.operationId]:authorization}));
    setPreview({kind:'recovery',record:review,target,authorization});
  }
  async function confirmRecovery(){
    const selected=previewRef.current;if(!client||selected?.kind!=='recovery'||selected.authorization?.state!=='reauthorization-required')return;
    const receipt=await client.reconcile(selected.record.operationId);if(!current())return;
    if(receipt.state==='acknowledged'){await settleRecovered(selected.record.operationId);return;}
    const fresh=await client.reviewPending(selected.record.operationId);if(!current())return;
    if(fresh.payloadHash!==selected.record.payloadHash||fresh.payloadJson!==selected.record.payloadJson||fresh.visibility!==selected.record.visibility||JSON.stringify(fresh.viewers)!==JSON.stringify(selected.record.viewers))throw Error('原操作记录已经变化，请重新查看原内容。');
    const target=await recoveryTarget(fresh);if(!current())return;
    if(target.state!=='ready'){setPendingChecks(old=>({...old,[fresh.operationId]:target}));setPreview({...selected,target,authorization:null});return;}
    const result=await client.reauthorize(selected.authorization,{confirmed:true});if(!current())return;
    if(result.state==='acknowledged'){await settleRecovered(fresh.operationId);return;}
    setPendingChecks(old=>({...old,[fresh.operationId]:result}));setPreview({...selected,authorization:result});await local();
  }
  function acceptChangedSource(){
    if(!current()||!sourceChange)return;
    if(sourceChange.kind==='task')setTaskView(sourceChange.task);
    else{
      const selected=formRef.current.editor;if(!selected||!sourceChange.source)return;
      if(sourceChange.kind==='comment')changeForm({editor:{...selected,kind:sourceChange.nextKind??selected.kind,comment:sourceChange.source}});
      else changeForm({editor:{...selected,report:sourceChange.source}});
    }
    setSourceChange(null);setPreview(null);setNotice('已改用当前内容，请核对文字和接收人后继续。');
  }
  const activePending=pending.filter(item=>item.state!=='stopped-local'),stopped=pending.filter(item=>item.state==='stopped-local');
  if(connected&&!commentConnectionCurrent(owner,runtime.api,connected))return <section className="task-comments-workspace"><h2>讨论</h2><p>身份或连接已改变，请重新打开当前任务。</p></section>;
  return <section className="task-comments-workspace discussion-panel">
    <header className="discussion-heading"><div><h2>讨论</h2><p>聊聊问题、方案和下一步。</p></div>{connected&&<Button disabled={busy||draftState!=='ready'} onClick={()=>begin('create')}><Pencil size={15}/>写评论</Button>}</header>
    {error&&<p className="message error" role="alert">{error}</p>}{notice&&<p className="message"><output>{notice}</output></p>}
    {typeof navigate==='function'&&<AccountVerificationPrompt required={connected&&verificationRequired} navigate={target=>void run(async()=>{await saveDraft();await client?.draft.flush();if(current())navigate(target);})}/>}
    {connected&&draftState==='unavailable'&&<div className="discussion-draft-warning"><p>{draftMessage}</p><div className="button-row"><Button variant="outline" disabled={busy} onClick={()=>void run(restoreDraft)}>重新读取草稿</Button>{hasRetainedDraft&&<Button variant="ghost" disabled={busy} onClick={()=>setPreview({kind:'discard'})}>放弃这份草稿</Button>}</div></div>}
    {connected&&draftMessage.startsWith('本机草稿尚未保存')&&<div className="discussion-draft-warning"><p>{draftMessage}</p><div className="button-row"><Button variant="outline" disabled={busy} onClick={()=>void run(()=>saveDraft())}>重试保存草稿</Button><Button variant="ghost" disabled={busy} onClick={()=>setPreview({kind:'reload-draft'})}>读取另一页保存的版本</Button></div></div>}
    {!!activePending.length&&<div className="discussion-pending">{activePending.map(record=>{const status=pendingChecks[record.operationId]??record;return <article key={record.operationId}><div><strong>{status.state==='unconfirmed'||status.state==='changed'?'上次的内容需要继续处理':record.type==='comment'?'正在确认这条评论的发送结果':'正在确认这份说明的发送结果'}</strong><p>{continuationMessage(status)}</p></div><button className="text-link" disabled={busy} onClick={()=>void run(()=>openRecovery(record))}>查看原内容 </button></article>;})}</div>}
    <form className="discussion-search" onSubmit={event=>{event.preventDefault();readingChange({query,submittedQuery:query.trim(),pages:1});setComments([]);setLoading(true);void run(()=>read({query:query.trim(),pages:1}));}}>
      <Search size={17}/><Input aria-label="查找讨论内容" value={query} maxLength={120} onChange={event=>{readingChange({query:event.target.value});}} placeholder="查找讨论内容"/><button type="submit" disabled={busy}>查找</button>{reading.submittedQuery&&<button type="button" aria-label="清除查找条件" disabled={busy} onClick={()=>{readingChange({query:'',submittedQuery:'',pages:1});setComments([]);setLoading(true);void run(()=>read({query:'',pages:1}));}}><X size={16}/></button>}
    </form>
    {loading&&!comments.length?<p className="discussion-reading"><output>正在读取讨论…</output></p>:!comments.length&&<div className="discussion-empty"><MessageCircle size={30}/><h3>{reading.submittedQuery?'暂时没有匹配的评论':'开始这段讨论'}</h3><p>{reading.submittedQuery?'换个关键词再找找。':'可以先澄清问题，或者说说你的想法。'}</p></div>}
    {comments.length>0&&next&&<p className="discussion-order">已加载内容按发布时间排列</p>}
    <CommentStream comments={comments} subjectId={subjectId} requesterId={taskView.requesterId} connected={connected} busy={busy} person={person} menu={menu} onMenuChange={(id,open)=>setMenu(value=>open?id:value===id?null:value)} begin={begin} onReports={id=>void run(()=>openReports(id))}/>
    {next&&<Button className="discussion-more-comments" variant="ghost" disabled={busy||loading} onClick={()=>{const pages=readingRef.current.pages+1;readingChange({pages});setLoading(true);void run(()=>read({pages}));}}>查看更多评论</Button>}
    {!connected&&<p className="discussion-connect">连接身份后，可以加入讨论。<button className="text-link" onClick={()=>navigate('/app/settings/identity')}>连接身份 </button></p>}
    {editor&&draftState==='ready'&&<form ref={editorElement} className="discussion-editor workspace-form" onSubmit={event=>{event.preventDefault();void run(prepare);}}>
      <header><div><p className="eyebrow">{governanceAction?'评论处理':editor.kind==='create'&&editor.comment?'回复评论':editor.kind==='create'?'写下你的想法':actions[editor.kind]}</p><h3>{governanceAction?actions[editor.kind]:editor.kind==='create'?'继续这段讨论':actions[editor.kind]}</h3></div><button type="button" className="icon-button" aria-label="放弃编辑" disabled={busy} onClick={()=>{if(text.trim()||reason.trim())setPreview({kind:'discard'});else void run(discardDraft);}}><X size={18}/></button></header>
      {editor.comment&&<div className="discussion-editor-source">{editor.comment.authorId&&<strong>{person(editor.comment.authorId)}</strong>}{replyFresh?.commentId===editor.comment.commentId&&replyFresh.revision===editor.comment.revision&&replyFresh.body?<blockquote>{replyFresh.body}</blockquote>:<p>原内容已变化或正在重新读取。你的输入仍保留。</p>}</div>}
      {editor.report&&<p className="discussion-editor-context">针对这条评论的{states[editor.report.state??'']??'处理记录'}补充说明。</p>}
      <fieldset disabled={busy}>
        {editor.kind==='report'&&<label>问题类型<select value={category} onChange={event=>setCategory(event.target.value)}>{[['advertising','广告或无关推广'],['harassment','骚扰'],['privacy','隐私'],['review-request','请求复核我的内容'],['other','其他']].map(([value,title])=><option key={value} value={value}>{title}</option>)}</select></label>}
        {editor.kind==='retract'?<p>撤回后这条评论不再展示，其他人的回复会保留。</p>:<label htmlFor={fieldId+'-text'}><span>{governanceAction?'说明':'评论内容'}</span><Textarea id={fieldId+'-text'} required aria-label={governanceAction?'处理说明':'评论内容'} maxLength={governanceAction?1600:6000} value={text} onChange={event=>setText(event.target.value)} placeholder={governanceAction?'写下需要说明的情况':'说说你的想法…'}/></label>}
        {editor.kind==='correct'&&<label htmlFor={fieldId+'-reason'}>更正原因<Input id={fieldId+'-reason'} required maxLength={600} value={reason} onChange={event=>setReason(event.target.value)}/></label>}
        {editor.kind==='pause'&&<label htmlFor={fieldId+'-minutes'}>暂时停止展示多久（分钟）<Input id={fieldId+'-minutes'} type="number" required min={1} max={10080} value={pauseMinutes} onChange={event=>setPauseMinutes(Number(event.target.value))}/></label>}
        {editor.kind==='resolve'&&<div className="discussion-form-pair"><label>处理结论<select value={verdict} onChange={event=>setVerdict(event.target.value)}><option value="dismissed">所报问题不成立</option><option value="upheld">所报问题成立</option></select></label><label>发布复核<select value={disposition} onChange={event=>setDisposition(event.target.value)}><option value="unchanged">保持当前状态</option><option value="approve" disabled={!editor.report?.canReviewSource}>通过</option><option value="reject" disabled={!editor.report?.canReviewSource}>不通过</option></select></label></div>}
        {['pause','resolve'].includes(editor.kind)&&<label htmlFor={fieldId+'-rule'}>处理依据<Input id={fieldId+'-rule'} required maxLength={120} value={rule} onChange={event=>setRule(event.target.value)}/></label>}
        {(privateTask||governanceAction)&&editor.kind!=='retract'?<Audience ids={availableAudience} selected={audience} onChange={setAudience} names={names} subjectId={subjectId}/>:editor.kind!=='retract'&&<p className="discussion-audience-note">这条评论会公开显示。</p>}
        {governanceAction&&audience.some(id=>id!==subjectId&&!allowedAudience.includes(id))&&<p className="discussion-audience-note">{audience.filter(id=>id!==subjectId&&!allowedAudience.includes(id)).map(person).join('、')}目前不在可接收这份说明的名单中，请取消勾选后继续。</p>}
        {governanceAction&&config?.configured===false&&<p className="discussion-audience-note">{config?.scopeRequired?'当前设备尚未开放评论处理权限。可以在身份设置中核对。':'当前未配置处理者，这份说明会仅供自己保留。'}</p>}
      </fieldset>
      {quotaBlocked&&<p className="message">今天可发布的公开评论已用完。{commentQuota?.resetAt&&'可在 '+new Date(commentQuota.resetAt).toLocaleString('zh-CN')+' 后继续。'}输入已保留。</p>}
      <footer><span>{draftMessage.startsWith('本机草稿尚未保存')?'草稿暂未保存':draftMessage?'草稿已保存在本机':''}</span><Button type="submit" disabled={busy||quotaBlocked||!!(governanceAction&&config?.unavailable)}>{busy?'请稍候…':governanceAction||editor.kind==='retract'?'查看并确认':editor.kind==='create'?'发送评论':editor.kind==='edit'?'保存修改':'发送更正'}</Button></footer>
    </form>}
    {connected&&<section ref={reportsElement} className="discussion-management">
      <ReadingDetails open={reportOpen} onOpenChange={open=>{if(open===readingRef.current.reportOpen)return;readingChange({reportOpen:open});if(open)void run(()=>openReports());}}><ReadingSummary>评论处理</ReadingSummary><div className="discussion-reports">{reportComment&&<div className="discussion-report-scope"><p>这条评论的相关处理</p><button className="text-link" disabled={busy} onClick={()=>void run(()=>loadReports(undefined,1))}>查看本任务其他处理</button></div>}{config?.scopeRequired&&<p>{config.message}</p>}{!reports.length&&!config?.scopeRequired&&<p className="muted">{busy?'正在读取相关处理…':'当前没有向你开放的相关处理说明。'}</p>}<CommentReports reports={reports} busy={busy} person={person} begin={begin} onReadAndBegin={(kind,id)=>void run(async()=>begin(kind,undefined,await client!.report(id)))}/>{reportNext&&<Button variant="ghost" disabled={busy} onClick={()=>void run(()=>loadReports(reportComment??undefined,readingRef.current.reportPages+1))}>更多处理记录</Button>}</div></ReadingDetails>
      <ReadingDetails className="discussion-account-details"><ReadingSummary>发言信息</ReadingSummary><p>讨论用于澄清和交流。参与、交付与验收在协作进程中分别确认。</p>{commentQuota&&<p>{privateTask?'本任务的私有评论不占公开评论额度。':'今日公开评论 '+commentQuota.used+'/'+commentQuota.limit+'；各设备共用，普通编辑不增加计数。'}</p>}{quota?.unavailable&&<p>当前未能读取账号额度。</p>}{!!stopped.length&&<ReadingDetails><ReadingSummary>已停止发送的记录</ReadingSummary>{stopped.map(record=><p key={record.operationId}>已停止本机发送，服务结果仍在自动核对。<code>{record.operationId}</code></p>)}</ReadingDetails>}</ReadingDetails>
    </section>}
    <dialog ref={dialog} className="galaxy-dialog discussion-dialog" onCancel={event=>{event.preventDefault();if(!busy)setPreview(null);}}>
      {preview&&<><button className="dialog-close" aria-label="关闭" disabled={busy} onClick={()=>setPreview(null)}><X size={19}/></button>
        {preview.kind==='prepared'&&<><p className="eyebrow">发送前确认</p><h3>{actions[preview.operation.payload.kind??'report']}</h3><p className="reading-prose">{preview.operation.payload.body??preview.operation.payload.summary??'撤回这条评论，其他人的回复会保留。'}</p>{preview.operation.payload.reason&&<p>原因：{preview.operation.payload.reason}</p>}{preview.operation.payload.until&&<p>暂停至 {new Date(preview.operation.payload.until*1000).toLocaleString('zh-CN')}</p>}{preview.operation.payload.verdict&&<p>结论：{preview.operation.payload.verdict==='upheld'?'问题成立':'问题不成立'}；发布复核：{({unchanged:'保持当前状态',approve:'通过',reject:'不通过'})[preview.operation.payload.reviewDisposition??'unchanged']}</p>}<p className="muted">{preview.operation.viewers.length?'这份内容将发送给：':'这次记录仅自己可见。'}</p><div className="discussion-recipients">{preview.operation.viewers.map((id:string)=><span key={id}><MemberAvatar subjectId={id}/>{person(id)}</span>)}</div><div className="button-row"><Button disabled={busy} onClick={()=>void run(async()=>{if(await validateTarget(preview.snapshot))await executePrepared(preview.operation,preview.snapshot);})}>{busy?'请稍候…':preview.operation.payload.kind==='retract'?'确认撤回':'确认发送'}</Button><Button variant="outline" disabled={busy} onClick={()=>setPreview(null)}>返回修改</Button></div></>}
        {['discard','replace-draft','reload-draft'].includes(preview.kind)&&<><h3>{preview.kind==='reload-draft'?'读取另一页保存的版本？':preview.kind==='replace-draft'?'切换前先处理当前草稿':'放弃这份草稿？'}</h3>{text&&<blockquote className="reading-prose">{text}</blockquote>}<p>{preview.kind==='reload-draft'?'本页尚未保存的修改会被替换。':form.operationId?'这份文字已进入发送流程。清除编辑稿不会停止原发送；如需停止，请从原内容中选择停止这次发送。':'这份尚未发送的文字会被清除。'}</p><div className="button-row"><Button variant="outline" disabled={busy} onClick={()=>setPreview(null)}>继续写这份草稿</Button><Button disabled={busy} onClick={()=>void run(async()=>{const action=preview;if(action.kind==='reload-draft'){setPreview(null);await restoreDraft();return;}await discardDraft();if(action.kind==='replace-draft')beginNow(action.next.kind,action.next.comment,action.next.report);})}>{preview.kind==='reload-draft'?'读取保存的版本':preview.kind==='replace-draft'?'放弃原稿并切换':form.operationId?'只清除编辑稿':'确认放弃草稿'}</Button></div></>}
        {preview.kind==='recovery'&&<><p className="eyebrow">上次发送的内容</p><h3>{actions[preview.record.payload?.kind??(preview.record.type==='report'?'report':'create')]}</h3><p className="reading-prose">{preview.record.payload?.body??preview.record.payload?.summary??'撤回原评论'}</p>{preview.record.payload?.reason&&<p>更正原因：{preview.record.payload.reason}</p>}{preview.record.payload?.until&&<p>原暂停截止：{new Date(preview.record.payload.until*1000).toLocaleString('zh-CN')}</p>}{preview.record.payload?.verdict&&<p>原处理结论：{preview.record.payload.verdict==='upheld'?'问题成立':'问题不成立'}</p>}
          <section className="discussion-recovery-scope"><h4>{preview.record.visibility==='Public'?'公开显示':preview.record.viewers.length?'这份内容发送给':'这份内容仅自己可见'}</h4>{preview.record.visibility==='Private'&&<div className="discussion-recipients">{preview.record.viewers.map((id:string)=><span key={id}><MemberAvatar subjectId={id}/>{person(id)}</span>)}</div>}
            {preview.authorization?.state==='reauthorization-required'?<>{preview.authorization.originalExpiresAt&&preview.authorization.originalExpiresAt!==preview.authorization.expiresAt&&<p>原许可期限：{new Date(preview.authorization.originalExpiresAt*1000).toLocaleString('zh-CN')}</p>}{!preview.authorization.originalExpiresAt&&<p>此前的许可期限暂未确认。</p>}<p>{preview.authorization.originalExpiresAt===preview.authorization.expiresAt?'许可仍保持至 ':'本次重新授权后，可读取至 '}{new Date(preview.authorization.expiresAt*1000).toLocaleString('zh-CN')}</p></>:preview.record.expiresAt&&<p>原许可期限：{new Date(preview.record.expiresAt*1000).toLocaleString('zh-CN')}</p>}
          </section>
          {preview.target?.state!=='ready'?<p className="message">{continuationMessage(preview.target)}</p>:preview.authorization?.state==='unconfirmed'?<p className="message">{continuationMessage(preview.authorization)}</p>:<p className="muted">确认后，按上面的原内容与接收范围继续。</p>}
          <ReadingDetails className="discussion-operation-details"><ReadingSummary>记录信息</ReadingSummary><dl><dt>原操作</dt><dd>{preview.record.operationId}</dd>{(preview.record.payload.expectedRevision??0)>0&&<><dt>原评论版本</dt><dd>{preview.record.payload.expectedRevision}</dd></>}{preview.record.payload?.replyTo&&<><dt>回复的版本</dt><dd>{preview.record.payload.replyTo.revision}</dd></>}{preview.record.payload?.target&&<><dt>处理的版本</dt><dd>{preview.record.payload.target.revision}</dd></>}{preview.record.payload?.expectedVersion&&<><dt>原处理版本</dt><dd>{preview.record.payload.expectedVersion}</dd></>}</dl></ReadingDetails>
          <div className="button-row">{preview.authorization?.state==='reauthorization-required'&&preview.target?.state==='ready'&&<Button disabled={busy||preview.authorization.expiresAt<=Math.floor(now/1000)} onClick={()=>void run(confirmRecovery)}>{busy?'请稍候…':'确认重新授权并继续'}</Button>}{preview.target?.state==='waiting'&&<Button variant="outline" disabled={busy} onClick={()=>void run(()=>openRecovery(preview.record))}>重新读取原目标</Button>}<Button variant="outline" disabled={busy} onClick={()=>setPreview(null)}>返回讨论</Button><Button variant="ghost" disabled={busy} onClick={()=>setPreview({kind:'stop-original',record:preview.record})}>停止这次发送</Button></div></>}
        {preview.kind==='stop-original'&&<><h3>停止这次发送？</h3><p>本机会停止继续发送。已到达服务的请求仍可能完成，结果会继续核对。</p><div className="button-row"><Button variant="outline" disabled={busy} onClick={()=>setPreview(null)}>保留并返回</Button><Button disabled={busy} onClick={()=>void run(async()=>{const id=preview.record.operationId;const receipt=await client!.reconcile(id);if(!current())return;if(receipt.state==='acknowledged'){await settleRecovered(id);return;}const result=await client!.stopLocalRetry(id,{confirmed:true});if(!current())return;await completeDraft(id);setPreview(null);setNotice(result.state==='acknowledged'?'这次内容已经发送。':'已停止本机发送。');await local();await read();})}>确认停止</Button></div></>}
      </>}
    </dialog>
    <dialog ref={changeDialog} className="galaxy-dialog discussion-dialog" onCancel={event=>{event.preventDefault();if(!busy)setSourceChange(null);}}>
      {sourceChange&&<><button className="dialog-close" aria-label="关闭变化说明" disabled={busy} onClick={()=>setSourceChange(null)}><X size={19}/></button><p className="eyebrow">内容有变化</p><h3>{sourceChange.kind==='task'?'任务的可见范围已改变':sourceChange.kind==='comment'?'原评论已有变化':'处理记录已有变化'}</h3>{sourceChange.kind==='task'?<p>当前任务为{sourceChange.task.request?.visibility==='Private'?'私有':'公开'}任务，请重新核对这次内容的接收范围。</p>:sourceChange.kind==='comment'&&sourceChange.source?.body?<blockquote className="reading-prose">{sourceChange.source.body}</blockquote>:sourceChange.kind==='report'&&sourceChange.source?.events?<div>{sourceChange.source.events.map((event)=><p className="reading-prose" key={event.eventId}>{event.summary}</p>)}</div>:<p>原内容当前无法读取，不能继续这项操作。</p>}<p className="muted">你的文字保留在编辑框中。</p><div className="button-row"><Button variant="outline" disabled={busy} onClick={()=>setSourceChange(null)}>返回编辑</Button>{sourceChange.canContinue&&<Button disabled={busy} onClick={acceptChangedSource}>{sourceChange.kind==='comment'&&sourceChange.nextKind==='correct'?'改为追加更正':'按当前内容继续编辑'}</Button>}</div></>}
    </dialog>
  </section>;
}
