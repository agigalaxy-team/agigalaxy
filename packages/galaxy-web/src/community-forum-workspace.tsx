import React, { useCallback, useEffect, useEffectEvent, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, BookOpen, Code2, Grid2X2, Leaf, MessageCircle, Palette, Plus, Search, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { AccountVerificationPrompt, needsAccountVerification } from './account-verification-prompt';
import { createCommunityForumClient, forumDraftPayload, forumError, forumScopeKey, newForumDraft } from './community-forum-client.mjs';
import { forumReplyPath, forumTaskPath, forumVersionPath, normalizeForumOrigin } from './community-forum-origin.mjs';
import { MemberAvatar, MemberLink, memberName, useMemberNames } from './conversation-ui';
import { SaveForLaterButton } from './reading-bookmarks-workspace';
import {AgentWorkContinuation} from './agent-work-continuation';
import {useChoiceViewLease,type ChoiceViewLease} from './choice-retained-operations';
import {chatErrorCode,type ChatRuntime} from './chat-workspace-types';
import {forumBodyParagraphs,forumBrowseFocus,forumBrowsePath,forumBrowseSelection,forumLinkLabel,readForumBrowsePosition,saveForumBrowsePosition,readForumPages as readPages} from './community-forum-browse.mjs';
import {forumTopics,forumReadTopicSchema} from '../../galaxy-official/src/shared/community-forum-topics-v1.mjs';
import './community-forum-workspace.css';
import {availableForumContent,forumPayload,forumPreviewProjection,forumCategory,forumResolution,assertForumPrepared,forumSourceTarget,forumSourceTargetFromDraft,forumTargetString,type ForumDraft,type ForumKind,type ForumDraftTarget,type ForumDraftValues,type ForumPreviewPayload,type ForumPayload,type ForumClient,type ForumCardView,type ForumContentView,type ForumPostView,type ForumReplyView,type ForumVersionEntry,type ForumOwnedPost,type ForumOwnedReply,type ForumPermission,type ForumConfig,type ForumQuota,type ForumPending,type ForumReview,type ForumReport,type ForumReceipt,type ForumLocator,type ForumPostsQuery} from './community-forum-view-types';

type Props = { runtime: ChatRuntime|null; subjectId?: string; connected: boolean; navigate: (path: string) => void;
  postId?: string; versionId?: string; replyId?: string; reportId?: string; section?: string; compose?: boolean; manage?: boolean;
  routeSearch?:string; browseReturn?:string; browseReturnLabel?:string };
const labels: Record<string, string> = { 'create-post': '写一条帖子', 'publish-version': '发表下一版', 'create-reply': '写回复',
  'withdraw-post': '撤回整条帖子', 'withdraw-version': '撤回这一版', 'withdraw-reply': '撤回我的回复', 'create-report': '私有举报',
  supplement: '补充我的举报', 'withdraw-report': '撤回我的举报', appeal: '提交申诉', resolve: '记录处理决定' };
const resolutionLabels:Record<string,string>={dismissed:'不成立',accepted:'成立','needs-review':'需要进一步核对'};
const categories = [['spam', '垃圾信息'], ['harassment', '骚扰'], ['privacy', '隐私'], ['misleading', '误导'], ['other', '其他']];
const states: Record<string, string> = { expired: '此内容的公开许可已到期。', withdrawn: '此内容已撤回。', unavailable: '此内容当前不可读。' };
const reasons: Record<string, string> = { 'content-expired': '公开许可到期', 'consent-revoked': '原许可已主动撤销',
  'binding-explicitly-revoked': '发表时连接被主动撤销', 'source-device-revoked': '发表设备已撤销', 'deletion-pending': '资料正在退出',
  'governance-hidden': '内容处于有限处理期限', 'historical-cause-unavailable': '原许可原因需要核对' };
const date = (seconds: number) => new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false });
const sessionStore=()=>{try{return window.sessionStorage;}catch{return undefined;}};
const publicWrite = (kind: string) => ['create-post', 'publish-version', 'create-reply'].includes(kind);
const needsAccount = (kind: string) => publicWrite(kind) || kind === 'create-report';
const ownRef = (value: ForumDraft|null) => value ? { id: value.id, revision: value.revision } : null;
const targetPath = (locator: ForumLocator|null|undefined) => locator?.replyId ? forumReplyPath(locator.replyId)
  : locator?.postId && locator?.versionId ? forumVersionPath(locator.postId, locator.versionId)
    : locator?.reportId ? `/app/community/reports/${locator.reportId}` : null;

function Body({body}:{body:string}) {
  return <div className="forum-prose">{forumBodyParagraphs(body).map((paragraph:string,index:number)=><p key={index}>{paragraph}</p>)}</div>;
}

function Links({ links = [], titled = false }: { links?: string[]; titled?:boolean }) {
  const rows=links.map(forumLinkLabel).filter((value):value is NonNullable<typeof value>=>value!==null);
  if(!rows.length)return null;
  const list=<ul className="forum-links">{rows.map((value,index)=><li key={index}><a href={value.href} title={value.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"><span className="forum-link-text"><strong>{value.host}</strong>{value.detail&&<span>{value.detail}</span>}</span><ArrowUpRight size={16} aria-hidden="true"/></a></li>)}</ul>;
  return titled?<section className="forum-related" aria-label="相关链接"><h2>相关链接</h2>{list}</section>:list;
}

type ForumTopicOption={id:string;label:string;description:string};
type ForumFocusTarget='topic'|'results'|'tabs';
function ForumLink({target,children,className,active=false,focusTarget,navigate}:{target:string;children:React.ReactNode;className?:string;active?:boolean;focusTarget?:ForumFocusTarget;navigate:(path:string,focus?:ForumFocusTarget)=>void}) {
  return <a className={className} href={target} aria-current={active?'page':undefined} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(target,focusTarget);}}}>{children}</a>;
}
const topicIcons:Record<string,React.ComponentType<{size?:number;'aria-hidden'?:boolean}>>={technology:Code2,arts:Palette,learning:BookOpen,life:Leaf,galaxy:Sparkles};
function TopicNavigation({topics,selected,query,section,navigate}:{topics:readonly ForumTopicOption[];selected:string;query:string;section:string;navigate:(path:string,focus?:ForumFocusTarget)=>void}) {
  const option=(id:string,label:string)=>{
    const Icon=topicIcons[id]??Grid2X2,target=forumBrowsePath({section,topic:id,query});
    return <a key={id} href={target} className={id==='unclassified'?'forum-uncategorized':undefined} aria-current={selected===id?'page':undefined} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(target,'topic');}}}><Icon size={16} aria-hidden/>{label}</a>;
  };
  return <nav className="forum-topic-navigation" aria-label="按主题浏览"><h2>浏览主题</h2><div className="forum-topic-links">{option('','全部主题')}{topics.map(topic=>option(topic.id,topic.label))}{option('unclassified','未分类')}</div></nav>;
}

function PostTime({createdAt,updatedAt}:{createdAt?:number;updatedAt?:number}) {
  const published=typeof createdAt==='number'&&Number.isFinite(createdAt)?new Date(createdAt*1000):null;
  const updated=typeof updatedAt==='number'&&Number.isFinite(updatedAt)&&updatedAt!==(createdAt??updatedAt)?new Date(updatedAt*1000):null;
  const display=(value:Date)=>value.toLocaleDateString('zh-CN',{year:'numeric',month:'numeric',day:'numeric'});
  return <>{published&&<time dateTime={published.toISOString()} title={'发表于 '+date(createdAt!)}>{display(published)}</time>}{updated&&<time dateTime={updated.toISOString()} title={'作者更新于 '+date(updatedAt!)}>更新于 {display(updated)}</time>}</>;
}

function PreviewBody({ value }: { value: {kind:ForumKind;payload:ForumPayload|ForumPreviewPayload} }) {
  const payload = forumPreviewProjection(value.payload);
  return <><h3>{labels[value.kind]}</h3>{payload.title && <h4>{payload.title}</h4>}
    {payload.topic&&<p className="forum-topic-label">发布到 {forumTopics.find(topic=>topic.id===payload.topic)?.label}</p>}
    {(payload.body || payload.summary || payload.reason) && <Body body={payload.body ?? payload.summary ?? payload.reason ?? ''}/>}
    <Links links={payload.links} />
    {payload.publishedUntil && <p>公开许可至 <strong>{date(payload.publishedUntil)}</strong>。到期不会自动续期。</p>}
    {value.kind === 'withdraw-post' && <p>这会停止整条帖子各版的公开读取及新回复；别人已经发表的独立回复按各自许可继续。立即停读与实际清理分别记录。</p>}
    {value.kind === 'withdraw-version' && <p>这会停止所选版本的公开读取及新回复。已有独立回复不会因此被删除，也不会带出已撤回正文。</p>}
    {value.kind === 'withdraw-reply' && <p>这会停止这一条回复的公开读取，不改变其他人的独立内容。</p>}
    {value.kind === 'withdraw-report' && <p>撤回自己的举报，不代替已经发生的处理决定或他人的申诉。</p>}
    {value.kind === 'resolve' && <p>处理结果：{resolutionLabels[payload.resolution??'']}。{payload.effect ? `暂时停止目标内容读取，最迟到 ${date(payload.effect.until)}。` : '本次不新增停止读取期限。'}</p>}
    {!publicWrite(value.kind) && !value.kind.startsWith('withdraw-') && <p className="muted">这是当前获准人员可见的私有记录，不公开举报者文字，也不自动恢复任何内容。</p>}
  </>;
}

function PermissionDetail({ value }: { value: ForumPermission|null }) {
  return value ? <div className="message"><p>此版公开许可至 {date(value.publishedUntil)}。</p><p>发表时连接到期：{date(value.originBindingExpiresAt)}。自然到期不自动缩短这份内容许可。</p>{value.stoppedReasons?.length ? <p>本次核对的停止原因：{value.stoppedReasons.map((reason: string) => reasons[reason] ?? '需要核对原许可').join('、')}。</p> : <p>本次核对未发现停止原因；后续读取仍按当时实际状态判断。</p>}<p>撤销原连接或设备可能停止它签署的内容。恢复控制权不会恢复另一台设备的本机稿。</p></div> : null;
}

async function firstForumRead(client:ForumClient,route:{reportId?:string;replyId?:string;postId?:string;versionId?:string;section:string;query:ForumPostsQuery}){
 const {reportId,replyId,postId,versionId,section,query}=route;
 if(reportId)return{kind:'report' as const,value:await client.report(reportId)};
 if(replyId)return{kind:'reply' as const,value:await client.reply(replyId)};
 if(postId)return{kind:'post' as const,value:versionId?await client.version(postId,versionId):await client.post(postId)};
 if(section==='reports')return{kind:'reports' as const,value:await client.reports()};
 return{kind:'cards' as const,value:section==='owned'?await client.owned(query):await client.posts(query)};
}
export function CommunityForumWorkspace(props:Props){
 const authority=useChoiceViewLease(props.runtime,props.subjectId),key=JSON.stringify([authority.key,forumScopeKey(props.runtime,props.subjectId),props.postId,props.versionId,props.replyId,props.reportId,props.section,props.compose,props.manage,props.connected,props.routeSearch]);
 return <CommunityForumView key={key} {...props} lease={authority.lease}/>;
}
function CommunityForumView({ runtime, subjectId, connected, navigate, postId, versionId, replyId, reportId, section: requestedSection = 'all', compose = false, manage = false, routeSearch = '', browseReturn = '/app/community', browseReturnLabel = '社区', lease }: Props&{lease:ChoiceViewLease|null}) {
  const section = ['all', 'owned', 'reports'].includes(requestedSection) ? requestedSection : 'all';
  const isFeed=!postId&&!replyId&&!reportId&&!compose;
  const {topic,query}=forumBrowseSelection(routeSearch,forumTopics.map(value=>value.id));
  const selectedTopic=forumTopics.find(value=>value.id===topic);
  const topicTitle=selectedTopic?.label??(topic==='unclassified'?'未分类':'全部帖子');
  const topicDescription=selectedTopic?.description??(topic==='unclassified'?'这些帖子还没有选择主题，原内容和讨论继续保留。':'从感兴趣的主题开始，也可以直接阅读最新发表的内容。');
  const feedPath=forumBrowsePath({section,topic,query});
  const returnPath=browseReturn==='/app/community'?feedPath:browseReturn;
  const returnedScope=new URL(returnPath,location.origin);
  const returnedSelection=forumBrowseSelection(returnedScope.search,forumTopics.map(value=>value.id));
  const returnLabel=returnedScope.pathname==='/app/community'?(returnedSelection.query?'搜索结果':returnedScope.searchParams.get('section')==='owned'?'我的帖子':forumTopics.find(value=>value.id===returnedSelection.topic)?.label??(returnedSelection.topic==='unclassified'?'未分类帖子':'社区')):browseReturnLabel;
  const listQuery=useMemo<ForumPostsQuery>(()=>{const selected=forumBrowseSelection(routeSearch,forumTopics.map(value=>value.id));return{...(selected.topic?{topic:forumReadTopicSchema.parse(selected.topic)}:{}),...(selected.query?{query:selected.query}:{}),order:'published'};},[routeSearch]);
  const [queryInput,setQueryInput]=useState(query),[feedOrder,setFeedOrder]=useState<'published'|'id'|null>(null);
  const browseScope=useMemo(()=>({endpoint:runtime?.api.endpoint??'',subjectId:subjectId??null}),[runtime,subjectId]);
  const [initialBrowsePosition]=useState(()=>isFeed?readForumBrowsePosition({state:history.state,storage:sessionStore(),scope:browseScope,route:location.pathname+location.search}):null);
  const restoreBrowse=useRef(initialBrowsePosition),pendingBrowseFocus=useRef(isFeed?forumBrowseFocus(history.state,location.pathname+location.search):null),replyAnchor=useRef<string|null>(null);
  const context = reportId ? `report:${reportId}` : postId ? `post:${postId}` : replyId ? `reply:${replyId}` : 'feed';
  const client = useMemo<ForumClient|null>(() => runtime ? createCommunityForumClient(runtime, { subjectId: subjectId ?? null, context }) : null, [runtime, subjectId, context]);
  const alive = useRef(true), working = useRef(false), readEpoch = useRef(0), draftEpoch = useRef(0), composeStarted = useRef(false);
  const editor = useRef<HTMLElement>(null),fieldId=useId();
  const feedPages=useRef(initialBrowsePosition?.pages??1),replyPages=useRef(1),versionPages=useRef(1),replyStarted=useRef(false);
  const [now,setNow]=useState(()=>Math.floor(Date.now()/1000));
  const isAvailable=<T extends ForumContentView|ForumCardView>(value:T|null)=>availableForumContent(value,now);
  const [reading, setReading] = useState(Boolean(client&&(connected||(!reportId&&(postId||replyId||section==='all'))))), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [verificationRequired, setVerificationRequired] = useState(false);
  const [items, setItems] = useState<ForumCardView[]>([]), [next, setNext] = useState<string | null>(null), [detail, setDetail] = useState<ForumPostView|null>(null);
  const [parent, setParent] = useState<ForumPostView|null>(null), [versions, setVersions] = useState<ForumVersionEntry[]>([]), [replies, setReplies] = useState<ForumReplyView[]>([]);
  const [versionNext, setVersionNext] = useState<number | null>(null), [ownPost, setOwnPost] = useState<ForumOwnedPost|null>(null);
  const [ownReply, setOwnReply] = useState<ForumOwnedReply|null>(null);
  const [replyNext, setReplyNext] = useState<string | null>(null), [permission, setPermission] = useState<ForumPermission|null>(null), [governanceRead, setGovernance] = useState<{draftId:string;value:ForumConfig}|null>(null);
  const [draftLoading, setDraftLoading] = useState(!!subjectId), [form, setForm] = useState<ForumDraft|null>(null), formRef = useRef<ForumDraft|null>(null);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [saveMessage, setSaveMessage] = useState(''), [saveFailed, setSaveFailed] = useState(false);
  const [pending, setPending] = useState<ForumPending[]>([]), [retryPreview, setRetryPreview] = useState<ForumReview|null>(null), [quotaRead, setQuota] = useState<{draftId:string;value:ForumQuota}|null>(null);
  const [pendingReason,setPendingReason]=useState(''),retryDialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{if(retryPreview)retryDialog.current?.showModal();else retryDialog.current?.close();},[retryPreview]);
  const [postOptions, setPostOptions] = useState(false);
  const [editorOpen,setEditorOpen]=useState(compose),[discardDraft,setDiscardDraft]=useState(false);
  const recoveryWorking = useRef(false);
  const [policyRead, setPolicy] = useState<{draftId:string;value:ForumQuota['policy']}|null>(null), [publicationRead, setPublicationUntil] = useState<{draftId:string;value:number}|null>(null);
  const [preparationFailure, setPreparationError] = useState<{draftId:string;reason:unknown}|null>(null);
  const [reportDetail,setReportDetail]=useState<ForumReport|null>(null),[reportItems,setReportItems]=useState<ForumReport[]>([]),[replyDetail,setReplyDetail]=useState<ForumReplyView|null>(null);
  const governance=form?.id===governanceRead?.draftId?governanceRead?.value:null,quota=form?.id===quotaRead?.draftId?quotaRead?.value:null,policy=form?.id===policyRead?.draftId?policyRead?.value:null,publicationUntil=form?.id===publicationRead?.draftId?publicationRead?.value:null;
  const preparationError=form?.id===preparationFailure?.draftId?preparationFailure?.reason:null;
  const contentDeadline=Math.min(...[detail,parent,replyDetail,...items,...replies].flatMap(value=>value?.availability==='available'&&typeof value.publishedUntil==='number'&&value.publishedUntil>now?[value.publishedUntil]:[]));
  useEffect(()=>{if(!Number.isFinite(contentDeadline))return;const timer=window.setTimeout(()=>setNow(Math.floor(Date.now()/1000)),Math.min(2147483647,Math.max(0,contentDeadline*1000-Date.now()+1)));return()=>window.clearTimeout(timer);},[contentDeadline]);
  const current = useCallback(() => { if (!alive.current || !client) return false; try { if(subjectId){if(!lease)return false;lease.assertCurrent();}client.check(); return true; } catch { return false; } },[client,subjectId,lease]);
  function rememberBrowse(target?:string) {
    if(!isFeed)return returnedScope.pathname==='/app/community'?readForumBrowsePosition({state:history.state,storage:sessionStore(),scope:browseScope,route:returnPath}):null;
    const requested=target?.match(/\/posts\/([0-9a-f-]{36})/)?.[1];
    const anchor=requested?document.getElementById('forum-post-'+requested):[...document.querySelectorAll<HTMLElement>('.forum-feed article[id]')].find(element=>element.getBoundingClientRect().bottom>100);
    const position=saveForumBrowsePosition({storage:sessionStore(),scope:browseScope,route:location.pathname+location.search,pages:feedPages.current,y:window.scrollY,anchor:anchor?.id??null,offset:anchor?.getBoundingClientRect().top??0});
    if(position)history.replaceState({...history.state,forumBrowse:position,forumBrowseFocus:null},'',location.href);
    return position;
  }
  const go = (target: string | null, focus?:ForumFocusTarget) => {
    if(!target)return;
    const position=rememberBrowse(target);
    navigate(target);
    if(position||focus){const destination=new URL(target,location.origin),route=destination.pathname+destination.search,returned=route===position?.route;history.replaceState({...history.state,...(position?(returned?{forumBrowse:position}:{browseReturn:position.route,forumBrowseReturn:position}):{}),forumBrowseFocus:focus?{route,target:focus}:null},'',location.href);}
  };
  const link = (target: string, text: React.ReactNode, className?: string, active=false, focus?:ForumFocusTarget) => <ForumLink target={target} className={className} active={active} focusTarget={focus} navigate={go}>{text}</ForumLink>;
  const rememberLatest=useEffectEvent(()=>{if(isFeed&&!restoreBrowse.current)rememberBrowse();});
  useEffect(()=>{
    const remember=()=>rememberLatest();window.addEventListener('pagehide',remember);
    const cancel=()=>{restoreBrowse.current=null;if(pendingBrowseFocus.current){pendingBrowseFocus.current=null;history.replaceState({...history.state,forumBrowseFocus:null},'',location.href);}};window.addEventListener('wheel',cancel,{passive:true});window.addEventListener('touchstart',cancel,{passive:true});window.addEventListener('keydown',cancel);window.addEventListener('pointerdown',cancel);
    return()=>{window.removeEventListener('pagehide',remember);window.removeEventListener('wheel',cancel);window.removeEventListener('touchstart',cancel);window.removeEventListener('keydown',cancel);window.removeEventListener('pointerdown',cancel);};
  },[]);
  useEffect(()=>{
    const position=restoreBrowse.current;if(!isFeed||!position||reading||error||!connected&&section!=='all')return;
    const frame=requestAnimationFrame(()=>{if(restoreBrowse.current!==position)return;const anchor=position.anchor?document.getElementById(position.anchor):null;
      window.scrollTo(0,anchor?window.scrollY+anchor.getBoundingClientRect().top-position.offset:position.y);
      if(anchor)anchor.querySelector<HTMLElement>('h2 a')?.focus({preventScroll:true});restoreBrowse.current=null;
    });return()=>cancelAnimationFrame(frame);
  },[isFeed,reading,error,items.length,reportItems.length,connected,section]);
  useEffect(()=>{
    const focus=pendingBrowseFocus.current;if(!isFeed||!focus||reading)return;
    const frame=requestAnimationFrame(()=>{if(pendingBrowseFocus.current!==focus)return;
      const selector=error?'.forum-workspace .message.error button':focus==='topic'?'.forum-topic-links a[aria-current="page"]':focus==='tabs'?'.forum-tabs a[aria-current="page"]':'.forum-feed article h2 a, .forum-result-empty h3';
      document.querySelector<HTMLElement>(selector)?.focus({preventScroll:true});pendingBrowseFocus.current=null;
      history.replaceState({...history.state,forumBrowseFocus:null},'',location.href);
    });return()=>cancelAnimationFrame(frame);
  },[isFeed,reading,error]);
  const displayError=useCallback((reason:unknown)=>{setError(forumError(reason));setVerificationRequired(needsAccountVerification(reason));},[]);
  const clearReading=useCallback(()=>{setDetail(null);setReplyDetail(null);setReportDetail(null);setParent(null);setItems([]);setReportItems([]);setReplies([]);setVersions([]);setPermission(null);setOwnPost(null);setOwnReply(null);},[]);
  async function readDraft() {
    if (!client || !subjectId) return;
    const ticket = ++draftEpoch.current, before = formRef.current;
    try {
      const value = await client.draft.load();
      if (!current() || ticket !== draftEpoch.current) return;
      setDraftLoaded(true);
      if (formRef.current === before) { formRef.current = value; setForm(value); setSaveMessage(value ? '本机稿已读取。' : '这里没有待编辑的本机稿。'); setSaveFailed(false); }
    } finally { if (current() && ticket === draftEpoch.current) setDraftLoading(false); }
  }
  async function readPending() { if (client && subjectId) { const value = await client.pending(); if (current()) setPending(value); } }
  function recoveryReason(reason:unknown){const code=chatErrorCode(reason);return code==='forum_publication_expired'?'authorization-expired':code==='consent_reauthorization_required'?(reason&&typeof reason==='object'&&'reason'in reason&&typeof reason.reason==='string'?reason.reason:'authorization-review-required'):'unconfirmed';}
  async function resumeQuietly(){
    if(!connected||!client?.resumePending||recoveryWorking.current)return;
    recoveryWorking.current=true;
    try{const result=await client.resumePending();if(current()){setPendingReason('');if(result.status==='acknowledged'){setRetryPreview(null);await readDraft();await readPending();}}}
    catch(reason){if(current())setPendingReason(recoveryReason(reason));}
    finally{recoveryWorking.current=false;}
  }
  async function reviewStored(operationId:string,kind:ForumKind){
    const result=await client!.reconcile(operationId);if(!current())return;
    if(result.status==='acknowledged'){setPendingReason('');await finish(result,kind);return;}
    const value=await client!.reviewOperation(operationId);if(current())setRetryPreview(value);
  }
  const refresh=async(initial?:{first:Awaited<ReturnType<typeof firstForumRead>>;ticket:number})=>{
    if(!client||!current()||!connected&&(reportId||!postId&&!replyId&&section!=='all'))return;
    setReading(true);
    const ticket=initial?.ticket??++readEpoch.current,valid=()=>current()&&ticket===readEpoch.current;
    try{
      const first=initial?.first??await firstForumRead(client,{reportId,replyId,postId,versionId,section,query:listQuery});if(!valid())return;
      if(first.kind==='report'){setReportDetail(first.value);setError('');}
      else if(first.kind==='reply'||first.kind==='post'){
        let value:ForumPostView|null=first.kind==='post'?first.value:null;
        const reply=first.kind==='reply'?first.value:null;
        const parentView=reply?await client.version(reply.locator.postId,reply.locator.postVersionId):null;
        if(!valid())return;
        if(value&&postId&&!versionId&&value.currentVersionId)value=await client.version(postId,value.currentVersionId);
        if(!valid())return;
        const selected=reply?parentView:value;if(!selected)return;
        const sourcePostId=selected.locator.postId,sourceVersionId=selected.locator.versionId;
        let afterVersion:number|undefined,versionCursor:number|null=null;const versionItems:ForumVersionEntry[]=[];
        for(let page=0;page<versionPages.current;page++){
          const result=await client.versions(sourcePostId,afterVersion===undefined?{}:{afterVersion});if(!valid())return;
          versionItems.push(...result.items);versionCursor=result.nextAfterVersion??null;
          if(versionCursor===null)break;if(versionCursor===afterVersion)throw Error('版本分页暂时无法继续。');afterVersion=versionCursor;
        }
        const requestedReply=replyAnchor.current??(/^#reply-([0-9a-f-]{36})$/.exec(location.hash)?.[1]);
        const replyPage=sourceVersionId?await readPages(after=>client.replies({postId:sourcePostId,postVersionId:sourceVersionId,...(after?{after}:{})}),replyPages.current,valid,undefined,requestedReply?item=>item.locator.replyId===requestedReply:undefined):null;
        if(replyPage)replyPages.current=replyPage.pagesRead;
        if(requestedReply&&replyPage?.items.some(item=>item.locator.replyId===requestedReply))replyAnchor.current=null;
        if(!valid())return;
        const ownerView=manage&&connected&&postId?await client.ownPost(postId):null;
        if(valid()){setDetail(value);setReplyDetail(reply);setParent(parentView);setVersions(versionItems);setVersionNext(versionCursor);setOwnPost(ownerView);setReplies(replyPage?.items??[]);setReplyNext(replyPage?.nextAfter??null);setError('');}
      }else if(first.kind==='reports'){
        const page=await readPages(after=>client.reports(after?{after}:{}),feedPages.current,valid,first.value);if(page&&valid()){feedPages.current=page.pagesRead;setReportItems(page.items);setNext(page.nextAfter);setError('');}
      }else{
        const returnedPost=restoreBrowse.current?.anchor?.replace('forum-post-','');
        const page=await readPages<ForumCardView>(after=>section==='owned'?client.owned({...listQuery,...(after?{after}:{})}):client.posts({...listQuery,...(after?{after}:{})}),feedPages.current,valid,first.value,returnedPost?item=>item.locator.postId===returnedPost:undefined);
        if(page&&valid()){feedPages.current=page.pagesRead;setItems(page.items);setNext(page.nextAfter);setFeedOrder(page.order??null);setError('');}
      }
      if(valid())setReading(false);
    }catch(reason){
      if(valid()){setReading(false);clearReading();displayError(reason);}
    }
  };
  async function run(action: () => Promise<void>) {
    if (!client || working.current||!current()) return;
    working.current = true; setBusy(true); setError(''); setNotice(''); setVerificationRequired(false);
    try { await action(); } catch (reason) { if (current()) displayError(reason); }
    finally { if (current()) { try { await readPending(); } catch (reason) { if (current()) displayError(reason); } if (current()) { working.current = false; setBusy(false); } } }
  }
  async function begin(kind: ForumKind, target: ForumDraftTarget = {}, values: ForumDraftValues = {}) {
    if (!subjectId) { if(kind==='create-reply'){const route=new URL(location.href);route.searchParams.set('reply','1');history.replaceState(history.state,'',route.pathname+route.search+route.hash);}go('/app/settings/identity'); return; }
    if (!client) return;
    if (formRef.current) throw Error('这里已有本机稿。先继续它，或明确取消编辑，再开始另一份。');
    const value = newForumDraft(kind, target, values), saved = await client.draft.save(value);
    if (current()) { formRef.current = saved; setForm(saved); setEditorOpen(true);setDiscardDraft(false);setRetryPreview(null); setSaveFailed(false); setSaveMessage('内容仅保存到此浏览器。'); requestAnimationFrame(() => { if (current()) { editor.current?.scrollIntoView({ block: 'start' }); editor.current?.querySelector<HTMLElement>('input,textarea')?.focus({ preventScroll: true }); } }); }
  }
  function change<K extends keyof ForumDraftValues>(field: K, value: ForumDraftValues[K]) {
    if (!client || !formRef.current || busy || draftLoading||!current()) return;
    try { client.check(); } catch (reason) { displayError(reason); return; }
    const nextForm = { ...formRef.current, [field]: value, revision: formRef.current.revision + 1 };
    formRef.current = nextForm; setForm(nextForm); setSaveMessage('正在保存本机稿…');
    void client.draft.save(nextForm).then(() => { if (current() && formRef.current === nextForm) { setSaveFailed(false); setSaveMessage('已保存到此浏览器。'); } })
      .catch((reason: unknown) => { if (current()) { setSaveFailed(true); setSaveMessage(forumError(reason)); } });
  }
  async function configForDraft(value: ForumDraft) {
    if (!client) return null;
    if (value.kind === 'create-report') return client.reportConfig({ target: forumSourceTargetFromDraft(value) });
    if (['supplement', 'withdraw-report', 'appeal', 'resolve'].includes(value.kind)) {
      const report = await client.report(forumTargetString(value.target.reportId)), config = await client.reportConfig({ target: report.target });
      return { ...config, report };
    }
    return null;
  }
  async function prepare(selectedAt:number) {
    if (!client || !formRef.current) return;
    const originalForm = formRef.current;
    await client.draft.flush();
    if (!current() || formRef.current !== originalForm) return;
    if(originalForm.kind==='create-post'&&!forumTopics.some(topic=>topic.id===originalForm.topic))throw Error('请选择这篇帖子的主题。');
    let currentPolicy = policy;
    if (needsAccount(originalForm.kind)) {
      const result = await client.quotas();
      if (!current()) return;
      setQuota({draftId:originalForm.id,value:result}); currentPolicy = result.policy; setPolicy({draftId:originalForm.id,value:result.policy});
      if (!result.accountVerified) throw Object.assign(Error('account_verification_required'), { code: 'account_verification_required' });
      if (quota && result.policyHash !== quota.policyHash) {
        setPublicationUntil({draftId:originalForm.id,value:selectedAt+result.policy.maxPermissionSeconds});
        throw Error('服务的发表规则刚刚变化，请核对当前公开期限和额度后再次发表。');
      }
    }
    if (publicWrite(originalForm.kind) && (!currentPolicy || !Number.isSafeInteger(currentPolicy.maxPermissionSeconds) || currentPolicy.maxPermissionSeconds < 1))
      throw Error('没有读到服务当前公开期限，请稍后重新核对。');
    if (originalForm.kind === 'create-reply') {
      const source = await client.version(forumTargetString(originalForm.target.postId), forumTargetString(originalForm.target.versionId));
      if (!isAvailable(source)) throw Error('原版当前不可读，不能向它新增回复。本机文字保留。');
    }
    const config = await configForDraft(originalForm);
    if (!current() || formRef.current !== originalForm) return;
    if (config) setGovernance({draftId:originalForm.id,value:config});
    const payload = forumPayload(originalForm.kind,forumDraftPayload(originalForm, { maxPermissionSeconds: currentPolicy?.maxPermissionSeconds ?? 0, maxGovernanceHideSeconds: Math.min(config?.maxGovernanceHideSeconds ?? 0, config?.maxPermissionSeconds ?? 0) },selectedAt));
    if (publicWrite(originalForm.kind)) {
      if (!('publishedUntil' in payload)) throw Error('当前稿件不是可公开发表的内容。');
      const now = selectedAt;
      if (!publicationUntil || publicationUntil <= now || publicationUntil > now + (currentPolicy?.maxPermissionSeconds??0)) {
        setPublicationUntil({draftId:originalForm.id,value:now+(currentPolicy?.maxPermissionSeconds??0)});
        throw Error('公开时间需要重新核对，当前文字仍在本机，请核对下面期限后发表。');
      }
      payload.publishedUntil = publicationUntil;
    }
    if(originalForm.kind==='resolve'&&!config?.report?.decisionRecipients)throw Error('当前处理接收人暂时无法核对，请保留这份说明。');
    const viewers = originalForm.kind === 'resolve' ? config?.report?.decisionRecipients??[] : config?.moderatorIds ?? [];
    const value = await client.prepare(originalForm.kind, payload, { viewers, draftRef: ownRef(originalForm),
      authorizationExpiresAt: selectedAt + (config?.maxPermissionSeconds ?? 3600) });
    if (!current() || formRef.current !== originalForm) return;
    assertForumPrepared(value);
    try { const result = await client.execute(value, { confirmed: true }); if (current()) await finish(result, originalForm.kind); }
    catch (reason) { if (current()) await readDraft(); throw reason; }
  }
  async function finish(result: ForumReceipt, kind: ForumKind) {
    if (!current()) return;
    const replyTarget=kind==='create-reply' ? formRef.current?.target ?? selected?.locator : null;
    if (kind.startsWith('withdraw-')) setPermission(null);
    if (kind === 'withdraw-reply') setOwnReply(null);
    setRetryPreview(null); await readDraft();
    if (!current()) return;
    const destination = targetPath(result.locator);
    if(kind==='create-reply'&&result.locator?.replyId&&replyTarget?.postId){replyAnchor.current=result.locator.replyId;await refresh();if(current())go(forumVersionPath(replyTarget.postId,replyTarget.versionId)+'#reply-'+result.locator.replyId);return;}
    if (['create-post', 'publish-version', 'create-reply', 'create-report'].includes(kind) && destination) { go(destination); return; }
    setNotice(kind.startsWith('withdraw-') ? '原撤回操作已确认。当前内容按最新状态读取。' : '原操作已确认。'); await refresh();
  }
  async function startVersion() {
    if (!client || !postId || !detail) return;
    const source = await client.version(postId,forumTargetString(detail.locator.versionId)), head = await client.post(postId);
    if (!current()) return;
    if (!isAvailable(source) || source.authorId !== subjectId) throw Error('只能从当前可读的本人版本准备更新。');
    await begin('publish-version', { postId, expectedHeadVersion: head.headVersion, versionId: source.locator.versionId,versionNumber:source.locator.versionNumber },
      { title: source.payload.title, body: source.payload.body, linksText: source.payload.links.join('\n'),topic:source.payload.topic??'unclassified' });
  }
  async function withdraw(kind:'withdraw-post'|'withdraw-reply',value:ForumOwnedPost|ForumOwnedReply|ForumReplyView){
    if(!client||!current())return;
    if(kind==='withdraw-reply'){if(value.locator.kind!=='reply')throw Error('原回复记录不完整，请重新读取。');await begin(kind,{replyId:value.locator.replyId});return;}
    if(!('headVersion'in value)||!Number.isSafeInteger(value.headVersion))throw Error('请从“我的帖子”重新读取本人记录，再选择撤回。');
    await begin(kind,{postId:value.locator.postId,expectedHeadVersion:value.headVersion});
  }
  async function startReport(value: ForumContentView) { await begin('create-report', forumSourceTarget(value)); }
  const refreshLatest=useEffectEvent(refresh);
  const restoreInput=useEffectEvent(async(records:ForumPending[])=>{if(subjectId&&current()){setPending(records);await readDraft();await resumeQuietly();await readPending();}});
  const tickLatest=useEffectEvent(async()=>{
    if(document.hidden||working.current||!current())return;
    await resumeQuietly();if(current())await refresh();
  });
  const clearPrivateReading=useEffectEvent(clearReading);
  const readFailure=useEffectEvent((reason:unknown)=>{if(current())displayError(reason);});
  const initialFailure=useEffectEvent((reason:unknown,ticket:number)=>{if(current()&&ticket===readEpoch.current){clearReading();displayError(reason);setReading(false);}});
  useEffect(()=>{
    const life=alive,readingVersion=readEpoch,draftVersion=draftEpoch;life.current=true;
    if(client&&current()&&(connected||!reportId&&(postId||replyId||section==='all'))){const ticket=++readingVersion.current;
      void firstForumRead(client,{reportId,replyId,postId,versionId,section,query:listQuery}).then(first=>refreshLatest({first,ticket})).catch(reason=>initialFailure(reason,ticket));
    }
    if(client&&subjectId&&current())void client.pending().then(restoreInput).catch(readFailure);
    const tick=()=>{if(!document.hidden){setNow(Math.floor(Date.now()/1000));void tickLatest().catch(readFailure);}};
    const visible=()=>{if(document.hidden)clearPrivateReading();else tick();};
    const timer=setInterval(tick,15000);document.addEventListener('visibilitychange',visible);
    return()=>{life.current=false;readingVersion.current++;draftVersion.current++;clearInterval(timer);document.removeEventListener('visibilitychange',visible);client?.close();};
  },[client,current,connected,reportId,replyId,postId,versionId,section,subjectId,listQuery]);
  const prepareDraft=useEffectEvent((draftId:string,active:()=>boolean)=>{
    const value=formRef.current;if(!client||!value||value.id!==draftId)return;
    const valid=()=>active()&&current()&&formRef.current?.id===draftId;
    if(needsAccount(value.kind))void client.quotas().then(result=>{if(valid()){setQuota({draftId,value:result});setPolicy({draftId,value:result.policy});setPublicationUntil({draftId,value:Math.floor(Date.now()/1000)+result.policy.maxPermissionSeconds});}}).catch(reason=>{if(valid())setPreparationError({draftId,reason});});
    if(!publicWrite(value.kind)&&!value.kind.startsWith('withdraw-'))void configForDraft(value).then(result=>{if(result&&valid())setGovernance({draftId,value:result});}).catch(reason=>{if(valid())setPreparationError({draftId,reason});});
  });
  const draftId=form?.id;
  useEffect(()=>{if(!client||!draftId||!connected)return;let active=true;prepareDraft(draftId,()=>active);return()=>{active=false;};},[client,draftId,connected]);
  const autoCompose=useEffectEvent(async()=>{
    if(!compose||composeStarted.current||!subjectId||draftLoading||!draftLoaded||!client||!current())return;
    composeStarted.current=true;if(formRef.current||working.current)return;working.current=true;
    try{await begin('create-post',{},selectedTopic?{topic:selectedTopic.id}:{});}finally{working.current=false;}
  });
  useEffect(()=>{void autoCompose().catch(readFailure);},[compose,subjectId,draftLoading,draftLoaded,client]);
  const autoReply=useEffectEvent(async()=>{
    if(replyStarted.current||new URLSearchParams(location.search).get('reply')!=='1'||!connected||!subjectId||!draftLoaded||formRef.current||!isAvailable(detail)||!postId||working.current||!current())return;
    replyStarted.current=true;working.current=true;
    try{await begin('create-reply',{postId,versionId:detail.locator.versionId,versionNumber:detail.locator.versionNumber});}
    finally{working.current=false;}
  });
  const detailVersionId=detail?.locator.versionId;
  useEffect(()=>{void autoReply().catch(readFailure);},[connected,subjectId,draftLoaded,detailVersionId]);
  const selected = replyId ? parent : detail;
  const selectedId = selected?.locator?.versionId;
  const selectedNumber=selected?.locator.versionNumber;
  const earlierVersion=!!selected?.currentVersionId&&selected.currentVersionId!==selectedId;
  const displayNames=useMemberNames(runtime,subjectId,connected,[...items.map(item=>item.authorId),detail?.authorId,replyDetail?.authorId,parent?.authorId,...replies.map(item=>item.authorId),...(retryPreview?.viewers??[])]);
  const forumName=(id?:string)=>memberName(id,subjectId,id?displayNames[id]??undefined:undefined);
  const own = !!subjectId && detail?.authorId === subjectId;
  const pendingActive = pending.find(item => item.state === 'awaiting-receipt');
  const recoveryNeedsReview=['authorization-expired','original-binding-changed','original-binding-unavailable','authorization-review-required'].includes(pendingReason);
  const displayedPublicationUntil = form?.operationId ? pending.find(item => item.operationId === form.operationId)?.publishedUntil ?? null : publicationUntil;
  const needConnection = <div className="message"><p>{subjectId ? '这台浏览器已有你的身份。连接后可以发表；本机稿仍属于原身份。' : '阅读无需登录。准备参与时，先建立或接回自己的银河身份。'}</p><Button onClick={() => go('/app/settings/identity')}>{subjectId ? '连接已有身份' : '建立或接回身份'}</Button></div>;
  async function loadMore() {
    if(!client||!next)return;
    if(section==='reports'){
      const page=await readPages(after=>client.reports({after:after??next}),1,current);
      if(page&&current()){feedPages.current+=page.pagesRead;setReportItems(old=>[...new Map([...old,...page.items].map(item=>[item.reportId,item])).values()]);setNext(page.nextAfter);}
    }else{
      const page=await readPages<ForumCardView>(after=>section==='owned'?client.owned({...listQuery,after:after??next}):client.posts({...listQuery,after:after??next}),1,current);
      if(page&&current()){
        feedPages.current+=page.pagesRead;setItems(old=>[...new Map([...old,...page.items].map(item=>[item.locator.postId,item])).values()]);setNext(page.nextAfter);
        const addedId=page.items.find(item=>!items.some(previous=>previous.locator.postId===item.locator.postId))?.locator.postId;
        if(addedId)requestAnimationFrame(()=>{if(current())document.querySelector<HTMLElement>('#forum-post-'+addedId+' h2 a')?.focus({preventScroll:true});});
      }
    }
  }
  const morePosts=next&&<div className="forum-load-more"><Button variant="outline" disabled={busy} onClick={()=>run(loadMore)}>继续读取</Button></div>;
  function resumeDraft(){setEditorOpen(true);setDiscardDraft(false);requestAnimationFrame(()=>{editor.current?.scrollIntoView({block:'start'});editor.current?.querySelector<HTMLElement>('input,textarea')?.focus({preventScroll:true});});}
  async function keepDraft(){await client!.draft.flush();if(!current())return;setEditorOpen(false);setDiscardDraft(false);setNotice('草稿已留在此浏览器，可以稍后继续。');if(compose)go(feedPath);}
  async function removeDraft(){const value=formRef.current;if(!value||value.operationId)return;if(await client!.draft.clear({id:value.id,revision:value.revision})){if(current()&&formRef.current===value){formRef.current=null;setForm(null);setDiscardDraft(false);setEditorOpen(false);setNotice('这份未提交草稿已删除。');if(compose)go(feedPath);}}else throw Error('草稿已变化，请先读取当前内容后再决定。');}
  function card(value: ForumCardView, owned = false) {
    const locator = value.locator, available = isAvailable(value), path = owned ? `/app/community/posts/${locator.postId}?manage=1` : targetPath(locator) ?? `/app/community/posts/${locator.postId}`;
    const category=available?forumTopics.find(item=>item.id===value.topic):null;
    return <article className="forum-card" id={'forum-post-'+locator.postId} key={locator.postId}>
      <div className="forum-meta"><MemberLink subjectId={value.authorId} name={forumName(value.authorId)} ownId={subjectId} navigate={go} avatar/><PostTime createdAt={value.createdAt} updatedAt={available?value.versionCreatedAt:undefined}/>{available&&link(forumBrowsePath({topic:category?.id??'unclassified'}),category?.label??'未分类','forum-topic-label')}</div>
      <h2>{link(path, available ? value.payload.title : 'state'in value&&value.state==='withdrawn'?'已撤回的帖子':'当前不可读取的帖子')}</h2>
      {available ? <p className="forum-excerpt">{value.payload.body.replace(/\s+/g,' ').trim()}</p> : <p>{states[value.availability??''] ?? '当前没有可展示的正文。'}</p>}
      <div className="forum-card-footer">{link(path, <><MessageCircle size={14}/>阅读与讨论</>)}{available&&value.payload.links?.length>0&&<span>{value.payload.links.length} 个相关链接</span>}</div>
    </article>;
  }
  const displayReply = (value: ForumReplyView) => <article className="forum-reply" id={'reply-' + value.locator.replyId} key={value.locator.replyId}>
    <div className="forum-meta"><MemberLink subjectId={value.authorId} name={forumName(value.authorId)} ownId={subjectId} navigate={go} avatar/><PostTime createdAt={value.createdAt}/>{link(forumReplyPath(value.locator.replyId)!, '查看此条')}</div>
    {isAvailable(value) ? <>{value.payload.replyTo && <p className="reply-context">回复 {link(forumReplyPath(value.payload.replyTo.replyId)!, '先前的讨论')}</p>}<Body body={value.payload.body}/></> : <p>{states[value.availability] ?? '当前无法读取这条回复。'}</p>}
    {isAvailable(value) && <div className="button-row">{isAvailable(selected) && <Button variant="ghost" disabled={busy || !!form} onClick={() => run(() => begin('create-reply', { postId: value.locator.postId, versionId: value.locator.postVersionId,versionNumber:selectedNumber }, { replyTo: { replyId: value.locator.replyId, contentRevision: 1 } }))}>回复此条</Button>}
      {value.authorId === subjectId ? <Button variant="ghost" disabled={busy || !!form} onClick={() => run(() => withdraw('withdraw-reply', value))}>撤回我的回复</Button> : <Button variant="ghost" disabled={busy || !!form} onClick={() => run(() => startReport(value))}>私有举报</Button>}</div>}
  </article>;

  return <section className={'forum-workspace'+(isFeed&&section!=='reports'?' forum-discovery':'')} aria-busy={busy}>
    {isFeed&&<><div className="forum-heading"><div><h1 className="small">社区</h1><p>分享想法、作品和日常，找到感兴趣的讨论。</p></div><Button disabled={busy} onClick={()=>go(forumBrowsePath({section,topic,query,compose:true}))}><Plus size={16}/>写帖子</Button></div><nav className="forum-tabs" aria-label="社区内容">{[['all','全部帖子'],['owned','我的帖子']].map(([value,text])=>link(forumBrowsePath({section:value,topic,query}),text,section===value?'active':undefined,section===value,'tabs'))}{link('/app/bookmarks','我的收藏')}{section==='reports'&&<span className="active">举报与处理</span>}{section==='owned'&&link('/app/community?section=reports','内容处理记录','forum-reports-link')}</nav></>}
    {!isFeed&&link(returnPath,<><ArrowLeft size={15}/>返回{returnLabel}</>,'back-link')}
    {compose&&!form&&<div className="forum-heading"><h1 className="small">写帖子</h1></div>}
    {reportId&&<h1 className="small">举报与处理</h1>}
    {error && <div className="message error" role="alert">{error}<AccountVerificationPrompt required={verificationRequired} navigate={go} /><Button variant="ghost" disabled={busy} onClick={() => void refresh()}>重新读取当前内容</Button></div>}
    {notice && <output className="message">{notice}</output>}
    {form&&!editorOpen&&!draftLoading&&<aside className="forum-draft-return" aria-label="未提交的草稿"><div><strong>{form.kind==='publish-version'?'这篇帖子的修改尚未发表':form.kind==='create-reply'?'你有尚未发出的回复':'你有尚未提交的草稿'}</strong><p>{form.title||labels[form.kind]} · 仅保存在此浏览器</p></div><Button variant="outline" disabled={busy} onClick={resumeDraft}>继续编辑</Button></aside>}
    {(!connected && (compose || form || reportId || section !== 'all')) && needConnection}
    {compose && subjectId && !form && !draftLoading && draftLoaded && <Button disabled={busy} onClick={() => run(() => begin('create-post',{},selectedTopic?{topic:selectedTopic.id}:{}))}>开始写这条帖子</Button>}
    {subjectId && !draftLoading && !draftLoaded && <Button variant="outline" disabled={busy} onClick={() => run(()=>readDraft())}>重新读取本机稿</Button>}
    {(!isFeed||section==='reports')&&reading && !detail && !replyDetail && !reportDetail && !items.length && !reportItems.length && <output className="empty-state">正在读取当前允许的内容…</output>}
    {isFeed&&section!=='reports'&&<div className="forum-discovery-layout">
      <TopicNavigation topics={forumTopics} selected={topic} query={query} section={section} navigate={go}/>
      <section className="forum-results" aria-labelledby={fieldId+'-scope'}>
        <header className="forum-scope-heading"><h2 id={fieldId+'-scope'}>{section==='owned'?'我的帖子':topicTitle}</h2><p>{section==='owned'?(topic?`当前主题：${topicTitle}。继续阅读或编辑自己发表的内容。`:'找到自己发表的内容，继续阅读、回复或编辑。'):topicDescription}</p></header>
        <search><form className="forum-search" onSubmit={event=>{event.preventDefault();go(forumBrowsePath({section,topic,query:queryInput}),'results');}}><label htmlFor={fieldId+'-search'}><span className="forum-search-label">搜索帖子</span><Input id={fieldId+'-search'} type="search" aria-label="搜索帖子" maxLength={160} value={queryInput} onChange={event=>setQueryInput(event.target.value)} placeholder={topic?'在当前主题中搜索标题或正文':'搜索帖子标题或正文'}/></label><Button type="submit" variant="outline"><Search size={16} aria-hidden/>搜索</Button></form></search>
        {query&&<div className="forum-search-context"><p>搜索“{query}”{topic&&<> · {topicTitle}</>}</p>{link(forumBrowsePath({section,topic}),'清除搜索','text-link',false,'results')}</div>}
        {feedOrder==='published'&&items.length>0&&<span className="forum-order-note">最新发表在前</span>}
        <div className="forum-feed" aria-busy={reading}>
          {items.map(value=>card(value,section==='owned'))}
          {reading&&!items.length&&<output className="empty-state">正在读取帖子…</output>}
          {!reading&&!error&&!items.length&&(section==='all'||connected)&&<div className="forum-result-empty"><h3 tabIndex={-1}>{query?'没有找到相符的帖子':section==='owned'?'这里还没有你的帖子':topic?'这个主题还没有可读的帖子':'社区还没有可读的帖子'}</h3><p>{query?'可以换一个词，或清除搜索继续浏览。':section==='owned'?'发表后，可以在这里找到并继续自己的内容。':'可以浏览其他主题，也可以写下自己的第一段内容。'}</p><div className="button-row">{query?link(forumBrowsePath({section,topic}),'清除搜索','text-link',false,'results'):topic?link(forumBrowsePath({section}),'浏览全部帖子','text-link',false,'topic'):null}{!query&&<Button variant="outline" onClick={()=>go(forumBrowsePath({section,topic,compose:true}))}>写一条帖子</Button>}</div></div>}
          {morePosts}
        </div>
      </section>
    </div>}
    {isFeed&&section==='reports'&&<div className="forum-feed">{reportItems.map(item=><article className="forum-card" key={item.reportId}><h2>{link(`/app/community/reports/${item.reportId}`, '查看我的举报或受影响记录')}</h2><p>{item.state==='pending'?'已登记，尚待处理。':'有新的处理记录，可按当前权限查看。'}</p>{item.canAppeal&&<span className="tag">可以提交申诉</span>}</article>)}{!reading&&!error&&!reportItems.length&&connected&&<div className="empty-state">没有读到当前身份可见的举报或处理记录。</div>}{morePosts}</div>}

    {(postId&&detail||replyId&&replyDetail) && <>
      {replyId&&replyDetail ? <><div className="forum-parent-link">{link(forumVersionPath(replyDetail.locator.postId, replyDetail.locator.postVersionId)!,<><ArrowLeft size={14}/>{isAvailable(parent)?parent.payload.title:'查看原帖'}</>)}{!isAvailable(parent)&&<p>原帖当前不可读取。</p>}</div>{displayReply(replyDetail)}</> : detail&&<article className="forum-post">
        <div className="forum-meta"><MemberLink subjectId={detail.authorId} name={forumName(detail.authorId)} ownId={subjectId} navigate={go} avatar/><PostTime createdAt={detail.createdAt} updatedAt={isAvailable(detail)?detail.versionCreatedAt:undefined}/>{isAvailable(detail)&&link(forumBrowsePath({topic:detail.topic??'unclassified'}),forumTopics.find(topic=>topic.id===detail.topic)?.label??'未分类','forum-topic-label')}</div>
        {isAvailable(detail) ? <><h1>{detail.payload.title}</h1>{(earlierVersion||versions.length>1)&&<div className="forum-version-context"><p>{earlierVersion?'正在阅读较早公开的内容':detail.currentVersionId===selectedId?'正在阅读最新公开的内容':'正在阅读这次发表的内容'}{selectedNumber? ' · 第 '+selectedNumber+' 版':''}。这里的回复保留在这次发表的内容下。</p>{earlierVersion&&link(forumVersionPath(postId!,detail.currentVersionId)!,'阅读更新后的内容','text-link')}</div>}<div className="forum-post-body"><Body body={detail.payload.body}/><Links links={detail.payload.links} titled/></div></> : <div className="empty-state">{states[detail.availability] ?? '暂时无法读取，请稍后重试。'}</div>}
        {isAvailable(detail) && <div className="forum-post-actions"><Button disabled={busy || !!form} onClick={() => run(() => begin('create-reply', { postId, versionId: selectedId, versionNumber: detail.locator.versionNumber }))}><MessageCircle size={16} />回复</Button>
          <SaveForLaterButton runtime={runtime} subjectId={subjectId} connected={connected} reference={{kind:'forum-post',postId:detail.locator.postId}} onNeedIdentity={()=>go('/app/settings/identity')}/>
          {own && <Button variant="ghost" disabled={busy || !!form} onClick={() => run(()=>startVersion())}>编辑帖子</Button>}
          <button className="forum-options-toggle" aria-expanded={postOptions} onClick={()=>setPostOptions(value=>!value)}>帖子资料</button></div>}
        {isAvailable(detail)&&selectedId&&<AgentWorkContinuation runtime={runtime} subjectId={subjectId} object={{kind:'post',id:detail.locator.postId,versionId:selectedId}} title={detail.payload.title} purpose="接着阅读这次发表的内容，围绕我的问题理解、整理或准备回应" onNeedIdentity={()=>go('/app/settings/identity')}/>}
        {postOptions&&<section className="forum-post-details" aria-label="帖子资料"><h2>版本与相关操作</h2><nav className="forum-versions" aria-label="帖子版本">{versions.map(value=>link(forumVersionPath(postId!,value.locator.versionId)!,`版本 ${value.locator.versionNumber}${value.locator.versionId===selectedId?' · 正在阅读':''}`))}{versionNext!==null&&<Button variant="ghost" disabled={busy} onClick={()=>run(async()=>{const page=await client!.versions(postId!,{afterVersion:versionNext});if(current()){versionPages.current++;setVersions(old=>[...old,...page.items]);setVersionNext(page.nextAfterVersion??null);}})}>更早版本</Button>}</nav><p className="muted">{detail.publishedUntil&&<>此版公开至 {date(detail.publishedUntil)}。</>}各次更新保留相应讨论。</p><div className="button-row">
          <Button variant="ghost" disabled={busy} onClick={() => run(async () => { const value = await client!.version(postId!,forumTargetString(selectedId)); if (!isAvailable(value)) throw Error('此版本当前不可读，不能继续采用它准备任务。'); if (current()) go(forumTaskPath({ postId, versionId: selectedId, returnTo: location.pathname + location.hash },{selectMaterial:value.authorId===subjectId})); })}>为这件事准备任务</Button>
          {!own&&<Button variant="ghost" disabled={busy||!!form} onClick={()=>run(()=>startReport(detail))}>举报</Button>}{own&&link(`/app/community/posts/${postId}?manage=1`,'管理我的版本')}</div></section>}
      </article>}
      {replyId && connected && <details className="forum-owner-actions"><summary>管理本人回复</summary><Button variant="ghost" disabled={busy} onClick={() => run(async () => { const value = await client!.ownReply(replyId); if (current()) setOwnReply(value); })}>核对本人回复记录</Button>{ownReply && <><p>这条本人回复的公开许可至 {date(ownReply.publishedUntil)}。{ownReply.availability !== 'available' && (states[ownReply.availability] ?? '当前不可读。')}</p><div className="button-row">{ownReply.state !== 'withdrawn' && <Button variant="outline" disabled={busy || !!form} onClick={() => run(() => withdraw('withdraw-reply', ownReply))}>撤回本人回复</Button>}<Button variant="ghost" disabled={busy} onClick={() => run(async () => { const value = await client!.permission(ownReply.permissionId); if (current()) setPermission(value); })}>核对回复许可</Button></div><PermissionDetail value={permission} /></>}</details>}
      {ownPost && <section className="forum-card" aria-label="本人帖子管理"><h2>我的帖子管理</h2><p>这里是本人记录。公开版本不可读时，仍可核对其许可与撤回范围。</p><div className="button-row">{ownPost.state !== 'withdrawn' && <><Button disabled={busy || !!form} onClick={() => run(() => begin('publish-version', { postId, expectedHeadVersion: ownPost.headVersion }))}>写一个新版本</Button><Button variant="outline" disabled={busy || !!form} onClick={() => run(() => withdraw('withdraw-post', ownPost))}>撤回整条帖子</Button></>}</div>
        {ownPost.versionLocators.map((value) => <article className="forum-reply" key={value.locator.versionId}><h3>{link(forumVersionPath(postId!, value.locator.versionId)!, `第 ${value.locator.versionNumber} 版`)}</h3><p>公开许可至 {date(value.publishedUntil)}。{value.availability !== 'available' && (states[value.availability] ?? '当前不可读。')}</p><div className="button-row"><Button variant="ghost" disabled={busy} onClick={() => run(async () => { const result = await client!.permission(value.permissionId); if (current()) setPermission(result); })}>核对此版许可</Button>{value.state !== 'withdrawn' && ownPost.state !== 'withdrawn' && <Button variant="outline" disabled={busy || !!form} onClick={() => run(() => begin('withdraw-version', { postId, versionId: value.locator.versionId, expectedHeadVersion: ownPost.headVersion }))}>撤回此版</Button>}</div></article>)}<PermissionDetail value={permission} />
      </section>}
      {!replyId&&detail&&<section className="forum-replies" aria-label="这版帖子的回复"><h2>{versions.length>1&&selectedNumber?'第 '+selectedNumber+' 版下的讨论':'讨论'}{replies.length>0&&<span>{replies.length}{replyNext?'+':''}</span>}</h2>{!isAvailable(detail)&&<p className="muted">原帖当前不可读，已有回复按各自的公开范围展示。</p>}{replies.map(displayReply)}{!replies.length&&<p className="forum-discussion-empty">还没有回复，分享你的想法吧。</p>}{replyNext&&<Button variant="outline" disabled={busy} onClick={()=>run(async()=>{const page=await client!.replies({postId:forumTargetString(postId),postVersionId:forumTargetString(selectedId),after:replyNext});if(current()){replyPages.current++;setReplies(old=>[...old,...page.items]);setReplyNext(page.nextAfter??null);}})}>更多回复</Button>}{isAvailable(detail)&&!form&&<button className="forum-reply-start" onClick={()=>run(()=>begin('create-reply',{postId,versionId:selectedId,versionNumber:detail.locator.versionNumber}))}><MemberAvatar subjectId={subjectId}/><span>写下你的回复…</span><MessageCircle size={18}/></button>}</section>}
      <footer className="forum-reading-return">{link(returnPath,<><ArrowLeft size={15} aria-hidden/>继续浏览{returnLabel==='社区'?'社区帖子':returnLabel}</>)}</footer>
    </>}

    {reportId && reportDetail && <section className="forum-report"><h2>当前处理记录</h2><p>{reportDetail.state === 'pending' ? '已登记，尚待处理。' : '以下是当前允许查看的处理事实。'}</p><p>登记不等于已经受理，没有响应时限承诺。</p>
      {reportDetail.target && link(targetPath(reportDetail.target) ?? '/app/community', '返回准确目标')}
      {(reportDetail.events ?? []).map((event) => <article className="forum-reply" key={event.governanceEventId ?? event.operationId}><h3>{event.kind === 'report' ? event.authorId === subjectId ? '我的举报' : '获准查看的举报' : ({ supplement: '补充', withdraw: '撤回', appeal: '申诉', resolve: '处理决定' } as Record<string,string>)[event.kind] ?? '记录'}</h3>{(event.payload?.summary || event.payload?.reason) && <p className="forum-prose">{event.payload.summary ?? event.payload.reason}</p>}{event.payload?.resolution && <p>{({ dismissed: '不成立', accepted: '成立', 'needs-review': '需要进一步核对' } as Record<string,string>)[event.payload.resolution]}</p>}{event.payload?.effect?.until && <p>本次停止读取最迟至 {date(event.payload.effect.until)}，后续仍以当前许可和处理状态为准。</p>}{event.availability && event.availability !== 'available' && <p>这段私有文字当前不可读取。</p>}</article>)}
      <div className="button-row">{reportDetail.canSupplement && <Button disabled={busy || !!form} onClick={() => run(() => begin('supplement', { reportId, expectedReportVersion: reportDetail.version }))}>补充我的举报</Button>}{reportDetail.canWithdrawReport && <Button variant="outline" disabled={busy || !!form} onClick={() => run(() => begin('withdraw-report', { reportId, expectedReportVersion: reportDetail.version }))}>撤回我的举报</Button>}{reportDetail.canAppeal && <Button disabled={busy || !!form} onClick={() => run(() => begin('appeal', { reportId, expectedReportVersion: reportDetail.version }))}>提交申诉</Button>}{reportDetail.canModerate && <Button disabled={busy || !!form} onClick={() => run(() => begin('resolve', { reportId, expectedReportVersion: reportDetail.version }))}>记录处理决定</Button>}</div>
      {!reportDetail.events?.some((event) => event.payload?.summary) && <p className="muted">此入口只提供你获准查看的处理事实，举报者的私有文字不会因你是目标作者而公开。</p>}
    </section>}

    {subjectId && draftLoading && <output>正在读取这处本机稿…</output>}
    {subjectId && !draftLoading && form && editorOpen && <section ref={editor} className="forum-editor" aria-label="社区本机稿"><h2>{form.kind === 'create-reply' ? '写回复' : form.kind === 'publish-version' ? '编辑帖子' : labels[form.kind]}</h2>
      
      {publicWrite(form.kind)&&<div className="forum-draft-context"><p>这是你的私人草稿。只有点击“公开发表”才会把这段内容公开。</p>{form.kind==='publish-version'&&<p>从{form.target.versionNumber?'第 '+form.target.versionNumber+' 版':'已发表的内容'}继续修改；已公开的正文与回复保持原样。</p>}{form.kind==='create-reply'&&form.target.versionNumber&&<p>回复第 {form.target.versionNumber} 版的内容。</p>}</div>}
      {form.operationId && <p className="message">这份稿已关联原提交。先查询原结果或停止本机重试，再准备新的内容。</p>}
      <form className="workspace-form" onSubmit={event => { event.preventDefault(); const selectedAt=Math.floor(Date.now()/1000);void run(()=>prepare(selectedAt)); }}><fieldset disabled={busy || !!form.operationId}>
        {['create-post','publish-version'].includes(form.kind)&&<div className="forum-publication-topic"><label htmlFor={fieldId+'-topic'}>发布到<select id={fieldId+'-topic'} aria-label="发布主题" required={form.kind==='create-post'} value={form.kind==='create-post'?(forumTopics.some(topic=>topic.id===form.topic)?form.topic:''):form.topic??'unclassified'} onChange={event=>change('topic',event.target.value?forumReadTopicSchema.parse(event.target.value):undefined)}>{form.kind==='create-post'?<option value="" disabled>选择一个主题</option>:<option value="unclassified">未分类</option>}{forumTopics.map(topic=><option key={topic.id} value={topic.id}>{topic.label}</option>)}</select></label><p>{forumTopics.find(topic=>topic.id===form.topic)?.description??(form.kind==='publish-version'?'沿用原帖的未分类状态，也可以为这次更新选择一个主题。':'选一个适合的主题，让感兴趣的人更容易找到这篇帖子。')}</p></div>}
        {['create-post', 'publish-version'].includes(form.kind) && <label htmlFor={fieldId+"-title"}>标题<Input id={fieldId+"-title"} aria-label="标题" required maxLength={320} value={form.title} onChange={event => change('title', event.target.value)} placeholder="一句话说说你想分享的事" /></label>}
        {['create-post', 'publish-version', 'create-reply', 'create-report', 'supplement', 'appeal', 'resolve'].includes(form.kind) && <label htmlFor={fieldId+"-body"}>{publicWrite(form.kind) ? form.kind === 'create-reply' ? '回复内容' : '正文' : form.kind === 'appeal' ? '我的申诉说明' : form.kind === 'resolve' ? '我的处理理由' : '我的说明'}<Textarea id={fieldId+"-body"} aria-label={publicWrite(form.kind) ? form.kind === 'create-reply' ? '回复内容' : '正文' : form.kind === 'appeal' ? '我的申诉说明' : form.kind === 'resolve' ? '我的处理理由' : '我的说明'} required maxLength={form.kind === 'create-reply' ? 4000 : publicWrite(form.kind) ? 16000 : 3200} value={form.body} onChange={event => change('body', event.target.value)} placeholder={publicWrite(form.kind) ? '用自己的话写下来。' : '只写需要说明的事实，不复制目标的私有内容。'} /></label>}
        {['create-post', 'publish-version'].includes(form.kind) && <label htmlFor={fieldId+"-links"}>相关链接（可选，每行一条，最多 8 条）<Textarea id={fieldId+"-links"} value={form.linksText} maxLength={32768} onChange={event => change('linksText', event.target.value)} placeholder="https://…" /></label>}
        {form.kind === 'create-report' && <><label>需要处理的问题<select aria-label="需要处理的问题" value={form.category} onChange={event => change('category',forumCategory(event.target.value))}>{categories.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label><p className="muted">只向实际配置且获准的处理者披露你的说明；没有处理者时如实保留待处理状态。</p></>}
        {form.kind === 'resolve' && <><label>处理结果<select aria-label="处理结果" value={form.resolution} onChange={event => change('resolution',forumResolution(event.target.value))}><option value="needs-review">需要进一步核对</option><option value="dismissed">不成立</option><option value="accepted">成立</option></select></label><label><input aria-label="暂时停止目标内容读取" type="checkbox" checked={form.hide} onChange={event => change('hide', event.target.checked)} />暂时停止目标内容读取</label>{form.hide && <><label htmlFor={fieldId+"-hide"}>期望最长时数<Input id={fieldId+"-hide"} aria-label="期望最长时数" type="number" min={1 / 3600} max={24} step="any" value={form.hideHours} onChange={event => change('hideHours', Number(event.target.value))} /></label>{governance && <p>按当前规则，本次最长 {Math.floor(Math.min(form.hideHours * 3600, governance.maxGovernanceHideSeconds, governance.maxPermissionSeconds))} 秒。处理期限不会超过这份决定的有效许可。</p>}</>}</>}
      </fieldset>
      {publicWrite(form.kind) && <p className="forum-publication-note">公开发布{displayedPublicationUntil && <> · 至 {date(displayedPublicationUntil)}</>} · 可随时撤回</p>}
      {form.kind.startsWith('withdraw-') && <PreviewBody value={{ kind: form.kind, payload: {} }} />}
      {preparationError!==null&&preparationError!==undefined && <div className="message error" role="alert">{forumError(preparationError)}<AccountVerificationPrompt required={needsAccountVerification(preparationError)} navigate={go} /></div>}
      {needsAccount(form.kind) && quota?.accountVerified === false && <div className="message"><p>发表前需要完成一次账号验证。正在编辑的内容保留在此浏览器。</p><AccountVerificationPrompt required navigate={go} /></div>}
      {form.kind === 'create-report' && governance && !governance.moderatorIds.length && <p>当前没有可接收此记录的处理者，将保留待处理状态，不承诺响应时间。</p>}
      {!form.operationId && !publicWrite(form.kind) && !form.kind.startsWith('withdraw-') && governance && <p className="muted">{form.kind === 'resolve' ? '这份独立处理理由会告知举报者和目标作者。' : `这份说明只向当前获准的 ${governance.moderatorIds.length} 位处理者披露，目标作者不会因此获得举报者说明。`} 私有内容按本次明确许可读取，最长 {Math.floor(governance.maxPermissionSeconds / 86400)} 天；记录被接受不代表已经解决。</p>}
      <div className="button-row"><Button type="submit" disabled={busy || !connected || !!form.operationId || !!pendingActive || saveFailed || publicWrite(form.kind) && !publicationUntil}>{publicWrite(form.kind) ? '公开发表' : form.kind.startsWith('withdraw-') ? '确认撤回' : form.kind === 'create-report' ? '提交私有举报' : form.kind === 'appeal' ? '提交申诉' : '提交私有记录'}</Button><Button type="button" variant="outline" disabled={busy} onClick={()=>run(keepDraft)}>暂存并返回</Button><button type="button" className="text-link" disabled={busy||!!form.operationId} onClick={()=>setDiscardDraft(true)}>放弃草稿</button></div></form>
      {discardDraft&&<div className="forum-discard-choice" role="alert"><p>删除这份尚未提交的草稿？已发表的内容会保留。</p><div className="button-row"><Button variant="outline" disabled={busy} onClick={()=>setDiscardDraft(false)}>保留草稿</Button><Button variant="ghost" disabled={busy} onClick={()=>run(removeDraft)}>删除这份草稿</Button></div></div>}
      <output className={saveFailed ? 'message error' : 'muted'}>{saveMessage}</output>
      {saveFailed && <Button variant="outline" disabled={busy} onClick={() => run(readDraft)}>重新读取本机版本</Button>}
    </section>}

    {pendingActive && <section className="forum-pending-note" aria-label="上次提交状态"><p>{pendingReason==='authorization-expired'?'上次内容的原许可已到期，不能继续按原期限发送。':pendingReason==='original-binding-changed'?'当前连接与上次不同，需要核对原内容后继续。':pendingReason==='original-binding-unavailable'?'上次记录缺少原连接依据，需要核对原内容后继续。':'正在确认上次提交，内容已保留。'}</p><div className="button-row"><Button variant="outline" disabled={busy || !connected} onClick={()=>run(async()=>{if(recoveryNeedsReview){await reviewStored(pendingActive.operationId,pendingActive.kind);return;}try{const result=await client!.resumePending();if(current()&&result.status==='acknowledged')await finish(result,pendingActive.kind);}catch(reason:unknown){if(!current())return;const next=recoveryReason(reason);setPendingReason(next);if(next!=='unconfirmed')await reviewStored(pendingActive.operationId,pendingActive.kind);else throw reason;}})}>{recoveryNeedsReview?'核对原内容':'继续原提交'}</Button><Button variant="ghost" disabled={busy} onClick={()=>run(async()=>{await client!.stopLocalRetry(pendingActive.operationId,{confirmed:true});await readDraft();if(!current())return;setRetryPreview(null);setPendingReason('');setNotice('已停止继续发送。已经送达的内容仍会保留。');})}>停止继续发送</Button></div></section>}
    <dialog ref={retryDialog} className="workspace-dialog forum-recovery-dialog" onCancel={event=>{if(busy)event.preventDefault();else setRetryPreview(null);}}>{retryPreview&&<><header className="dialog-heading"><h2>核对上次提交</h2><button type="button" className="icon-button" aria-label="关闭原内容预览" disabled={busy} onClick={()=>setRetryPreview(null)}>×</button></header><PreviewBody value={retryPreview}/><p>可见范围：{retryPreview.visibility==='Public'?'公开':retryPreview.viewers?.length?retryPreview.viewers.map((id:string)=>memberName(id,subjectId,displayNames[id]??undefined)).join('、'):'仅自己'}。</p>{retryPreview.expiresAt?<p>原授权期限：{date(retryPreview.expiresAt)}。</p>:<p className="message">原授权期限暂时无法确认。</p>}{Number.isSafeInteger(retryPreview.expiresAt)&&typeof retryPreview.expiresAt==='number'&&retryPreview.expiresAt<=now&&<p className="message">原许可已到期，这次原提交不能继续发送。</p>}<details className="technical-details"><summary>原内容与准确记录</summary><pre>{JSON.stringify({operationId:retryPreview.operationId,payloadHash:retryPreview.payloadHash,originalBindingId:retryPreview.originalBindingId,payload:retryPreview.payload},null,2)}</pre></details>{error&&<p role="alert" className="message error">{error}</p>}<div className="button-row"><Button disabled={busy||!Number.isSafeInteger(retryPreview.expiresAt)||typeof retryPreview.expiresAt==='number'&&retryPreview.expiresAt<=now} onClick={()=>run(async()=>{const chosen=retryPreview;const result=await client!.retry(chosen.operationId,{confirmed:true,reauthorize:true});if(current()){setPendingReason('');await finish(result,chosen.kind);}})}>按原内容继续</Button><Button variant="ghost" disabled={busy} onClick={()=>setRetryPreview(null)}>暂不继续</Button></div></>}</dialog>
  </section>;
}

type TaskReturnProps={runtime:ChatRuntime|null;subjectId?:string;connected:boolean;task:{requesterId:string;taskId:string;request?:{operationId?:string}};navigate:(path:string)=>void};
export function CommunityTaskReturn(props:TaskReturnProps){
 const scope=useChoiceViewLease(props.runtime,props.subjectId);
 if(!props.runtime||!props.connected||!props.subjectId||props.task.requesterId!==props.subjectId||!scope.lease)return null;
 return <CommunityTaskReturnView key={JSON.stringify([scope.key,props.task.taskId,props.task.request?.operationId])} runtime={props.runtime} subjectId={props.subjectId} taskId={props.task.taskId} operationId={props.task.request?.operationId} navigate={props.navigate} lease={scope.lease}/>;
}
function CommunityTaskReturnView({runtime,subjectId,taskId,operationId,navigate,lease}:{runtime:ChatRuntime;subjectId:string;taskId:string;operationId?:string;navigate:(path:string)=>void;lease:ChoiceViewLease}){
 const [origin,setOrigin]=useState<{postId:string;versionId:string;returnTo:string}|null>(null);
 useEffect(()=>{
  let active=true;
  void runtime.getLocal('community-forum-task-origin:'+taskId,subjectId).then((value:unknown)=>{
   lease.assertCurrent();
   if(!active||!value||typeof value!=='object'||!('version'in value)||value.version!==1||!('ownerId'in value)||value.ownerId!==subjectId||!('endpoint'in value)||value.endpoint!==runtime.api.endpoint||!('taskId'in value)||value.taskId!==taskId||!operationId||!('operationId'in value)||value.operationId!==operationId||!('origin'in value))return;
   const raw=value.origin;if(!raw||typeof raw!=='object'||!('postId'in raw)||typeof raw.postId!=='string'||!('versionId'in raw)||typeof raw.versionId!=='string')return;
   const result=normalizeForumOrigin(raw);if(result)setOrigin({postId:raw.postId,versionId:raw.versionId,returnTo:result.returnTo});
  }).catch(()=>{if(active)setOrigin(null);});
  return()=>{active=false;};
 },[runtime,subjectId,taskId,operationId,lease]);
 return origin?<p className="browse-note"><a href={origin.returnTo} onClick={event=>{event.preventDefault();lease.assertCurrent();navigate(origin.returnTo);}}>返回原帖子版本</a><br/>原帖位置保存在此浏览器，回去后按当前公开许可读取。此本机返回记录不代表服务器增加了任务来源关系。</p>:null;
}
