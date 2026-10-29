import {SelectionRail} from '../../shared/navigation/SelectionRail';
import { labels, categories, states, date, publicWrite, sectionWrite, Body, Links, ForumLink, PostTime, PreviewBody, PermissionDetail, type ForumFocusTarget } from "./presentation";
import {AccountProfileAvatar} from "../accounts/account-profile-avatar";
import { ReadingSurface } from "../../shared/reading/reading-details";
import React, { useCallback, useEffect, useEffectEvent, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {MessageCircle, Search} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { createCommunityForumClient, forumDraftPayload, forumError, newForumDraft } from './community-forum-client.mjs';
import { forumReplyPath, forumTaskPath, forumVersionPath } from './community-forum-origin.mjs';
import { MemberAvatar, MemberLink, memberName, useMemberNames } from "../../shared/people/conversation-ui";
import { SaveForLaterButton } from "../bookmarks/controls";
import {AgentWorkContinuation} from "../local-galaxy/agent-work-continuation";
import {chatErrorCode,type ChatRuntime} from "../chat/chat-workspace-types";
import {forumBodyExcerpt,forumBrowseFocus,forumBrowsePath,forumBrowseSelection,readForumBrowsePosition,saveForumBrowsePosition,readForumPages as readPages} from './community-forum-browse.mjs';
import {forumTopics,forumReadTopicSchema} from "../../../../galaxy-contracts/src/community-forum-topics-v1.mjs";
import {ContentCover,contentCoverFromLinks} from './community-content-visuals';
import {CommunityExternalWorkspace,CommunityReadingSidebar} from './community-highlights';
import {communityBrowsePath,communitySelection} from './community-navigation';
import {OfficialAccountLoginNotice,type OfficialAccountModel} from "../accounts/official-account-panel";
import {AccountSessionScope,useAccountSessionModel} from "../accounts/account-session-scope";
import {clearForumLoginDraft,forumLoginDraft,rememberForumLoginDraft,forumAuthorAccountId,forumAuthorSubjectId,forumOwnsContent} from './forum-account-state.mjs';
import {ForumAudienceEditor,ForumAudienceSummary} from './forum-audience';
import {useQueryReads,sourceReadDeadline} from "../../application/query-reads";
import {LoadingFeedback,ReadFailure} from "../../shared/feedback/interaction-feedback";
import {useSiteContentReadyTransition} from "../../use-site-content-transition";
import {createCurrentOfficialAccount} from "../accounts/official-account-reading.mjs";
import {createDiscoveryClient} from "../discovery/client.mjs";
import {createPublicCommunityFeedback} from "../discovery/public-feedback.mjs";
import {ForumAttachmentComposer,ForumAttachmentFiles,type ForumDraftAttachment} from './forum-attachments';
import {forumAttachmentDraft} from './forum-attachment-client.mjs';
import type {ForumAccessOptions,ForumSection,ForumNotification,ForumAuthorFields} from './community-forum-view-types';
import './community-forum-workspace.css';
import {availableForumContent,forumPayload,forumCategory,forumResolution,assertForumPrepared,forumSourceTarget,forumSourceTargetFromDraft,forumTargetString,type ForumDraft,type ForumKind,type ForumDraftTarget,type ForumDraftValues,type ForumClient,type ForumCardView,type ForumContentView,type ForumPostView,type ForumReplyView,type ForumVersionEntry,type ForumOwnedPost,type ForumOwnedReply,type ForumPermission,type ForumConfig,type ForumQuota,type ForumPending,type ForumReview,type ForumReport,type ForumReceipt,type ForumLocator,type ForumPostsQuery} from './community-forum-view-types';

type Props = { runtime: ChatRuntime|null; subjectId?: string; connected: boolean; navigate: (path: string) => void;
  postId?: string; versionId?: string; replyId?: string; reportId?: string; memberSectionId?:string; section?: string; compose?: boolean; manage?: boolean;
  routeSearch?:string; browseReturn?:string; browseReturnLabel?:string;registerShellNavigation?:(isCurrent:()=>boolean,leaveAction:(action:()=>void)=>void)=>()=>void };
const noticeDeadline=(value:ForumNotification)=>Math.min(typeof value.sourceExpiresAt==='number'?value.sourceExpiresAt:Date.parse(value.sourceExpiresAt)/1000,value.readUntil??Infinity);
const leaseNotices=(values:ForumNotification[],startedAt:number)=>values.map(value=>({...value,readUntil:startedAt+15}));
const sessionStore=()=>{try{return window.sessionStorage;}catch{return undefined;}};
const needsAccount = (kind: string) => publicWrite(kind) || kind === 'create-report' || sectionWrite(kind);
const quotaTarget=(draft:ForumDraft)=>['publish-version','withdraw-post','withdraw-version'].includes(draft.kind)&&typeof draft.target.postId==='string'?{postId:draft.target.postId}:draft.kind==='withdraw-reply'&&typeof draft.target.replyId==='string'?{replyId:draft.target.replyId}:draft.kind==='update-section'&&typeof draft.target.sectionId==='string'?{sectionId:draft.target.sectionId}:{};
const ownRef = (value: ForumDraft|null) => value ? { id: value.id, revision: value.revision } : null;
const targetPath = (locator: ForumLocator|null|undefined) => locator?.replyId ? forumReplyPath(locator.replyId)
  : locator?.postId && locator?.versionId ? forumVersionPath(locator.postId, locator.versionId)
    : locator?.reportId ? `/app/community/reports/${locator.reportId}` : locator?.sectionId?`/app/community/sections/${locator.sectionId}`:null;

async function firstForumRead(client:ForumClient,route:{reportId?:string;replyId?:string;postId?:string;versionId?:string;memberSectionId?:string;section:string;query:ForumPostsQuery}){
 const {reportId,replyId,postId,versionId,memberSectionId,section,query}=route;
 if(memberSectionId)return {kind:'section' as const,value:await client.section(memberSectionId)};
 if(reportId)return{kind:'report' as const,value:await client.report(reportId)};
 if(replyId)return{kind:'reply' as const,value:await client.reply(replyId)};
 if(postId)return{kind:'post' as const,value:versionId?await client.version(postId,versionId):await client.post(postId)};
 if(section==='sections')return {kind:'sections' as const,value:await client.sections()};
 if(section==='notifications')return {kind:'notifications' as const,value:await client.notifications()};
 if(section==='reports')return{kind:'reports' as const,value:await client.reports()};
 return{kind:'cards' as const,value:section==='owned'?await client.owned(query):await client.posts(query)};
}
export function CommunityForumWorkspace(props:Props){
 return <AccountSessionScope endpoint={props.runtime?.api.endpoint}><CommunityForumSession {...props}/></AccountSessionScope>;
}
function CommunityForumSession(props:Props){
  const official=useAccountSessionModel(),currentOfficial=useRef(official);currentOfficial.current=official;
  const draftOwner=useRef<{endpoint:string|undefined;session:typeof official.session}>({endpoint:props.runtime?.api.endpoint,session:null});
  if(draftOwner.current.endpoint!==props.runtime?.api.endpoint||official.phase==='signed-out'||official.phase==='loading')draftOwner.current={endpoint:props.runtime?.api.endpoint,session:null};
  if(official.phase==='signed-in')draftOwner.current={endpoint:props.runtime?.api.endpoint,session:official.session};
  // A temporary connection failure keeps only the local draft's owner. Every
  // network action below still requires the current live account session.
  const session=official.session??(['offline','unavailable'].includes(official.phase)?draftOwner.current.session:null),accountId=session?.account.id,csrfToken=session?.csrfToken;
  const account=useMemo(()=>accountId&&csrfToken&&official.client?createCurrentOfficialAccount({client:official.client,accountId,csrfToken,getCurrent:()=>currentOfficial.current}):null,[accountId,csrfToken,official.client]);
  const key=JSON.stringify([accountId,csrfToken,official.phase==='loading',props.runtime?.api.endpoint,props.postId,props.versionId,props.replyId,props.reportId,props.memberSectionId,props.section,props.compose,props.manage,props.routeSearch]);
 if(!props.postId&&!props.replyId&&!props.reportId&&!props.memberSectionId&&!props.compose&&(!props.section||props.section==='all')&&communitySelection(props.routeSearch).source==='external')return <CommunityExternalWorkspace key={key} runtime={props.runtime} subjectId={props.subjectId} navigate={props.navigate} routeSearch={props.routeSearch}/>;
  return <CommunityForumView key={key} {...props} subjectId={undefined} connected={!!account} localSubjectId={props.subjectId} localConnected={props.connected} account={account} official={official}/>;
}
type ForumAccount=NonNullable<NonNullable<Parameters<typeof createCommunityForumClient>[1]>['account']>;
type ForumAccountProps={account:ForumAccount|null;official:OfficialAccountModel;localSubjectId?:string;localConnected:boolean};
type DetailSource={key:string;postId:string;versionId:string|null;replyId:string|null;managePost:boolean;ownReply:boolean};
function CommunityForumView({ runtime, subjectId, connected, navigate, postId, versionId, replyId, reportId, memberSectionId, section: requestedSection = 'all', compose = false, manage = false, routeSearch = '', browseReturn = '/app/community', browseReturnLabel = '社区', registerShellNavigation,account,official,localSubjectId,localConnected }: Props&ForumAccountProps) {
  const section = ['all', 'owned', 'reports','sections','notifications'].includes(requestedSection) ? requestedSection : 'all';
  const isFeed=!postId&&!replyId&&!reportId&&!memberSectionId&&!compose,postFeed=isFeed&&(section==='all'||section==='owned');
  const privatePage=section==='owned'||section==='reports'||section==='notifications';
  const {topic,query}=forumBrowseSelection(routeSearch,forumTopics.map(value=>value.id));
  const selectedTopic=forumTopics.find(value=>value.id===topic);
  const topicTitle=selectedTopic?.label??(topic==='unclassified'?'未分类帖子':'全部讨论');
  const topicDescription=selectedTopic?.description??(topic==='unclassified'?'这些帖子还没有选择主题，原内容和讨论继续保留。':'从感兴趣的主题开始，也可以直接阅读最新发表的内容。');
  const feedTitle=section==='sections'?'成员版块':section==='notifications'?'回复提醒':section==='reports'?'内容处理记录':query?`“${query}”的搜索结果`:section==='owned'?'我的帖子':topicTitle;
  const feedDescription=section==='sections'?'由成员发起和维护的长期讨论空间。也可以直接在社区发帖。':section==='notifications'?'回到与你有关、现在仍允许读取的讨论。':section==='reports'?'查看与你有关的举报、申诉和处理记录。':query?`搜索范围：${section==='owned'?'我的帖子':'银河讨论'}${topic?' · '+topicTitle:''}`:section==='owned'?(topic?`${topicTitle}中的本人帖子。继续阅读、回复或编辑。`:'继续阅读、回复或编辑自己发表的内容。'):topic?topicDescription:'从一个话题开始，也让想法继续。';
  const feedPath=forumBrowsePath({section,topic,query});
  const returnPath=browseReturn==='/app/community'?feedPath:browseReturn;
  const returnedScope=new URL(returnPath,location.origin);
  const returnedSelection=forumBrowseSelection(returnedScope.search,forumTopics.map(value=>value.id));
  const returnLabel=returnedScope.pathname==='/app/community'?(returnedSelection.query?'搜索结果':returnedScope.searchParams.get('section')==='owned'?'我的帖子':forumTopics.find(value=>value.id===returnedSelection.topic)?.label??(returnedSelection.topic==='unclassified'?'未分类帖子':'社区')):browseReturnLabel;
  const listQuery=useMemo<ForumPostsQuery>(()=>{const selected=forumBrowseSelection(routeSearch,forumTopics.map(value=>value.id));return{...(selected.topic?{topic:forumReadTopicSchema.parse(selected.topic)}:{}),...(selected.query?{query:selected.query}:{}),order:'published'};},[routeSearch]);
  const [queryInput,setQueryInput]=useState(query),[feedOrder,setFeedOrder]=useState<'published'|'id'|null>(null);
  const browseEndpoint=runtime?.api.endpoint??'',browseAccountId=account?.id??null;
  const browseScope=useMemo(()=>({endpoint:browseEndpoint,subjectId:browseAccountId?'account:'+browseAccountId:null}),[browseEndpoint,browseAccountId]);
  const [initialBrowsePosition]=useState(()=>isFeed?readForumBrowsePosition({state:history.state,storage:sessionStore(),scope:browseScope,route:location.pathname+location.search}):null);
  const restoreBrowse=useRef(initialBrowsePosition),pendingBrowseFocus=useRef(isFeed?forumBrowseFocus(history.state,location.pathname+location.search):null),replyAnchor=useRef<string|null>(null);
  const context = memberSectionId?`section:${memberSectionId}`:section==='sections'?'sections':reportId ? `report:${reportId}` : postId ? `post:${postId}` : replyId ? `reply:${replyId}` : 'feed';
  const feedback=useMemo(()=>runtime&&account?createPublicCommunityFeedback({endpoint:runtime.api.endpoint,accountId:account.id,websiteOrigin:location.origin}):null,[runtime,account]);
  const client = useMemo<ForumClient|null>(() => runtime ? createCommunityForumClient(runtime, { subjectId:null, context,account,browserDrafts:true,onAcknowledged:feedback?.participation }) : null, [runtime, context,account,feedback]);
  const backgroundRead=useRef<(lane:string,value:unknown)=>void>(()=>{});
  const detailReads=useQueryReads({endpoint:runtime?.api.endpoint??'',identity:account?.id??'anonymous',surface:'web'},'forum',JSON.stringify([context,versionId,manage]),(lane,value)=>backgroundRead.current(lane,value));
  const detailSource=useRef<DetailSource|null>(null),discussionAppend=useRef(false);
  const [visitorConflict,setVisitorConflict]=useState<{id:string;revision:number}|null>(null);
  const accountReady=official.phase!=='loading';
  const alive = useRef(true), working = useRef(false), readEpoch = useRef(0), draftEpoch = useRef(0), composeStarted = useRef(false);
  const editor = useRef<HTMLElement>(null),actionError=useRef<HTMLDivElement>(null),primaryContent=useRef<HTMLElement>(null),fieldId=useId();
  const [focusTarget,setFocusTarget]=useState<'editor'|'error'|null>(null);
  const feedPages=useRef(initialBrowsePosition?.pages??1),replyPages=useRef(1),versionPages=useRef(1),replyStarted=useRef(false);
  const [now,setNow]=useState(()=>Math.floor(Date.now()/1000));
  const isAvailable=<T extends ForumContentView|ForumCardView>(value:T|null)=>availableForumContent(value,now);
  const [reading, setReading] = useState(Boolean(client&&(connected||!reportId&&(postId||replyId||memberSectionId||!privatePage)))), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [items, setItems] = useState<ForumCardView[]>([]), [next, setNext] = useState<string | null>(null), [detail, setDetail] = useState<ForumPostView|null>(null);
  const [memberSections,setMemberSections]=useState<ForumSection[]>([]),[sectionDetail,setSectionDetail]=useState<ForumSection|null>(null),[notifications,setNotifications]=useState<ForumNotification[]>([]);
  const [accessOptions,setAccessOptions]=useState<ForumAccessOptions|null>(null),[sectionChoices,setSectionChoices]=useState<ForumSection[]>([]),[sectionChoiceNext,setSectionChoiceNext]=useState<string|null>(null);
  const [linksEditor,setLinksEditor]=useState(false),moreFeed=useRef<HTMLDivElement>(null),moreReplies=useRef<HTMLDivElement>(null);
  const [attachmentWorking,setAttachmentWorking]=useState(false);
  const [sectionPicker,setSectionPicker]=useState(false),[draftSourceRead,setDraftSourceRead]=useState<{draftId:string;value:ForumPostView}|null>(null);
  const [parent, setParent] = useState<ForumPostView|null>(null), [versions, setVersions] = useState<ForumVersionEntry[]>([]), [replies, setReplies] = useState<ForumReplyView[]>([]);
  const [versionNext, setVersionNext] = useState<number | null>(null), [ownPost, setOwnPost] = useState<ForumOwnedPost|null>(null);
  const [ownReply, setOwnReply] = useState<ForumOwnedReply|null>(null);
  const [versionsReading,setVersionsReading]=useState(!!(postId||replyId)),[versionsError,setVersionsError]=useState('');
  const [repliesReading,setRepliesReading]=useState(!!postId),[repliesError,setRepliesError]=useState('');
  const [managementReading,setManagementReading]=useState(manage),[managementError,setManagementError]=useState('');
  const [parentReading,setParentReading]=useState(!!replyId),[parentError,setParentError]=useState('');
  const [replyNext, setReplyNext] = useState<string | null>(null), [permission, setPermission] = useState<ForumPermission|null>(null), [governanceRead, setGovernance] = useState<{draftId:string;value:ForumConfig}|null>(null);
  const [draftLoading, setDraftLoading] = useState(true), [form, setForm] = useState<ForumDraft|null>(null), formRef = useRef<ForumDraft|null>(null);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [saveMessage, setSaveMessage] = useState(''), [saveFailed, setSaveFailed] = useState(false);
  const [pending, setPending] = useState<ForumPending[]>([]), [retryPreview, setRetryPreview] = useState<ForumReview|null>(null);
  const [pendingReason,setPendingReason]=useState(''),retryDialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{if(retryPreview)retryDialog.current?.showModal();else retryDialog.current?.close();},[retryPreview]);
  const [postOptions, setPostOptions] = useState(false);
  const [editorOpen,setEditorOpen]=useState(compose),[discardDraft,setDiscardDraft]=useState(false);
  const recoveryWorking = useRef(false);
  const [policyRead, setPolicy] = useState<{draftId:string;value:ForumQuota['policy']}|null>(null);
  const [preparationFailure, setPreparationError] = useState<{draftId:string;reason:unknown}|null>(null);
  const [reportDetail,setReportDetail]=useState<ForumReport|null>(null),[reportItems,setReportItems]=useState<ForumReport[]>([]),[replyDetail,setReplyDetail]=useState<ForumReplyView|null>(null);
  useSiteContentReadyTransition(primaryContent,!!(postId&&detail&&isAvailable(detail)||replyId&&replyDetail&&isAvailable(replyDetail)));
  const usage=useMemo(()=>runtime?.api.endpoint?createDiscoveryClient({endpoint:runtime.api.endpoint,websiteOrigin:location.origin}):null,[runtime?.api.endpoint]);
  const usageRead=useRef(new Set<string>());
  useEffect(()=>{
    if(!usage||privatePage||reportId||document.hidden)return;
    const content=replyDetail?.availability==='available'?{kind:'reply',id:replyDetail.locator.replyId,version:String(replyDetail.locator.contentRevision)}
      :detail?.availability==='available'&&detail.locator.versionId===detail.currentVersionId?{kind:'post',id:detail.locator.postId,version:detail.currentVersionId}:null;
    if(!content||!content.version)return;
    const key=content.kind+content.id+content.version;if(usageRead.current.has(key))return;usageRead.current.add(key);
    void usage.record({name:'content-view',pageKey:'community',content}).catch(()=>{});
  },[usage,privatePage,reportId,detail,replyDetail]);
  const governance=form?.id===governanceRead?.draftId?governanceRead?.value:null,policy=form?.id===policyRead?.draftId?policyRead?.value:null;
  const preparationError=form?.id===preparationFailure?.draftId?preparationFailure?.reason:null;
  const contentDeadline=Math.min(...[detail,parent,replyDetail,...items,...replies].flatMap(value=>value?.availability==='available'&&typeof value.publishedUntil==='number'&&value.publishedUntil>now?[value.publishedUntil]:[]),...notifications.filter(value=>noticeDeadline(value)>now).map(noticeDeadline));
  useEffect(()=>{if(!Number.isFinite(contentDeadline))return;const timer=window.setTimeout(()=>setNow(Math.floor(Date.now()/1000)),Math.min(2147483647,Math.max(0,contentDeadline*1000-Date.now()+1)));return()=>window.clearTimeout(timer);},[contentDeadline]);
  const current = useCallback(() => { if (!alive.current || !client) return false; try { client.check(); return true; } catch { return false; } },[client]);
  const hasForm=!!form;
  // Explicit actions request focus after React has committed the actual node.
  // Quiet reads never set this target, so they cannot move typing or reading.
  useLayoutEffect(()=>{
    if(!focusTarget||focusTarget==='editor'&&(!hasForm||!editorOpen||busy)||focusTarget==='error'&&!error)return;
    const target=focusTarget==='error'?actionError.current:editor.current;
    if(!target)return;
    target.scrollIntoView({block:focusTarget==='editor'?'start':'nearest'});
    if(focusTarget==='error')target.focus({preventScroll:true});
    else target.querySelector<HTMLElement>('input:not([type="hidden"]):not([type="file"]),textarea,select')?.focus({preventScroll:true});
    setFocusTarget(null);
  },[focusTarget,form?.id,hasForm,editorOpen,busy,error]);
  const leaveAction=useCallback((action:()=>void)=>{if(!client||!formRef.current){action();return;}void client.draft.flush().then(()=>{if(current())action();}).catch(reason=>{if(current()){setSaveFailed(true);setSaveMessage(forumError(reason));setError('输入尚未保存，先留在本页。可以保留文字后重试恢复草稿。');}});},[client,current]);
  useLayoutEffect(()=>registerShellNavigation?.(current,leaveAction),[registerShellNavigation,current,leaveAction]);
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
    if(target.startsWith('/app/community')){const url=new URL(target,location.origin);url.searchParams.delete('acting');url.searchParams.delete('account');target=url.pathname+url.search+url.hash;}
    const destinationPath=target;
    leaveAction(()=>{const position=rememberBrowse(destinationPath);navigate(destinationPath);
    if(position||focus){const destination=new URL(destinationPath,location.origin),route=destination.pathname+destination.search,returned=route===position?.route;history.replaceState({...history.state,...(position?(returned?{forumBrowse:position}:{browseReturn:position.route,forumBrowseReturn:position}):{}),forumBrowseFocus:focus?{route,target:focus}:null},'',location.href);}});
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
      const target=[...document.querySelectorAll<HTMLElement>(selector)].find(element=>element.getClientRects().length>0)??document.querySelector<HTMLElement>('.community-mobile-trigger');
      target?.focus({preventScroll:true});pendingBrowseFocus.current=null;
      history.replaceState({...history.state,forumBrowseFocus:null},'',location.href);
    });return()=>cancelAnimationFrame(frame);
  },[isFeed,reading,error]);
  const refreshAccount=official.refresh;
  const displayError=useCallback((reason:unknown)=>{setError(forumError(reason));if(['official_account_changed','official_account_session_expired'].includes(chatErrorCode(reason)??''))void refreshAccount();},[refreshAccount]);
  const clearReading=useCallback(()=>{detailReads.cancel();detailSource.current=null;discussionAppend.current=false;setDetail(null);setReplyDetail(null);setReportDetail(null);setParent(null);setItems([]);setReportItems([]);setReplies([]);setVersions([]);setPermission(null);setOwnPost(null);setOwnReply(null);setSectionDetail(null);setMemberSections([]);setNotifications([]);setSectionChoices([]);setVersionsReading(false);setRepliesReading(false);setManagementReading(false);setParentReading(false);setVersionsError('');setRepliesError('');setManagementError('');setParentError('');},[detailReads]);
  async function readDraft() {
    if (!client || !accountReady) return;
    const ticket = ++draftEpoch.current, before = formRef.current;
    try {
      let value = await client.draft.load();
      const original=account?forumLoginDraft({endpoint:runtime!.api.endpoint,context,path:location.pathname+location.search+location.hash}):null;
      if(original){const restored=await client.draft.importVisitor(original);if(restored.status==='imported'){value=restored.draft;clearForumLoginDraft(original);setVisitorConflict(null);}else if(restored.status==='occupied')setVisitorConflict(original);else clearForumLoginDraft(original);}
      if (!current() || ticket !== draftEpoch.current) return;
      setDraftLoaded(true);
      if (formRef.current === before) { formRef.current = value; setForm(value); setSaveMessage(value ? '草稿已恢复。' : ''); setSaveFailed(false); }
    } finally { if (current() && ticket === draftEpoch.current) setDraftLoading(false); }
  }
  async function readPending() { if (client && accountReady) { const value = await client.pending(); if (current()) setPending(value); } }
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
  const sourceCurrent=(source:DetailSource)=>current()&&detailSource.current?.key===source.key;
  const readFirst=(force=false)=>detailReads.run({lane:'primary',key:JSON.stringify([reportId,replyId,postId,versionId,memberSectionId,section,listQuery])},()=>firstForumRead(client!,{reportId,replyId,postId,versionId,memberSectionId,section,query:listQuery}),{force,validUntil:sourceReadDeadline});
  async function loadVersions(source=detailSource.current,quiet=false){
    if(!client||!source)return;const depth=versionPages.current;
    return detailReads.run({lane:'versions',key:source.key+':'+depth},async({signal})=>{
      let afterVersion:number|undefined,nextAfterVersion:number|null=null;const rows:ForumVersionEntry[]=[];
      for(let page=0;page<depth;page++){const result=await client.versions(source.postId,afterVersion===undefined?{}:{afterVersion});if(signal.aborted)throw new DOMException('Read replaced','AbortError');rows.push(...result.items);nextAfterVersion=result.nextAfterVersion??null;if(nextAfterVersion===null)break;if(nextAfterVersion===afterVersion)throw Error('版本分页暂时无法继续。');afterVersion=nextAfterVersion;}
      return{items:rows,nextAfterVersion};
    },{validUntil:sourceReadDeadline,onStart:()=>{if(!quiet)setVersionsReading(true);setVersionsError('');},onSuccess:value=>{if(sourceCurrent(source)){setVersions(value.items);setVersionNext(value.nextAfterVersion);}},onError:()=>{if(sourceCurrent(source)){setVersions([]);setVersionNext(null);setVersionsError('版本记录暂时无法读取。');}},onSettled:()=>{if(sourceCurrent(source))setVersionsReading(false);}});
  }
  async function loadDiscussion(source=detailSource.current,after?:string,quiet=false){
    if(!client||!source||!source.versionId||source.replyId){setRepliesReading(false);return;}
    if(!after&&discussionAppend.current)return;if(after)discussionAppend.current=true;
    const selectedVersion=source.versionId,depth=replyPages.current,requestedReply=replyAnchor.current??(/^#reply-([0-9a-f-]{36})$/.exec(location.hash)?.[1]);
    return detailReads.run({lane:'replies',key:JSON.stringify([source.key,after??null,depth,requestedReply])},async({signal})=>{
      const valid=()=>sourceCurrent(source)&&!signal.aborted;
      if(after){const page=await client.replies({postId:source.postId,postVersionId:selectedVersion,after});return{...page,pagesRead:1};}
      return readPages<ForumReplyView>(after=>client.replies({postId:source.postId,postVersionId:selectedVersion,...(after?{after}:{})}),depth,valid,undefined,requestedReply?item=>item.locator.replyId===requestedReply:undefined);
    },{validUntil:sourceReadDeadline,onStart:()=>{if(!quiet)setRepliesReading(true);setRepliesError('');},onSuccess:page=>{if(page&&sourceCurrent(source)){replyPages.current=after?replyPages.current+page.pagesRead:page.pagesRead;setReplies(old=>after?[...new Map([...old,...page.items].map(item=>[item.locator.replyId,item])).values()]:page.items);setReplyNext(page.nextAfter??null);if(requestedReply&&page.items.some(item=>item.locator.replyId===requestedReply))replyAnchor.current=null;}},onError:()=>{if(sourceCurrent(source)){setReplies([]);setReplyNext(null);setRepliesError('讨论暂时无法读取。');}},onSettled:()=>{if(sourceCurrent(source)){discussionAppend.current=false;setRepliesReading(false);}}});
  }
  async function loadManagement(source=detailSource.current,quiet=false){
    if(!client||!source)return;
    if(!source.managePost&&!source.ownReply){setManagementReading(false);setManagementError('');return;}
    return detailReads.run({lane:'management',key:source.key},async()=>{
      const [post,reply]=await Promise.all([source.managePost?client.ownPost(source.postId):null,source.ownReply&&source.replyId?client.ownReply(source.replyId):null]);return{post,reply};
    },{validUntil:sourceReadDeadline,onStart:()=>{if(!quiet)setManagementReading(true);setManagementError('');},onSuccess:value=>{if(sourceCurrent(source)){setOwnPost(value.post);setOwnReply(value.reply);}},onError:()=>{if(sourceCurrent(source)){setOwnPost(null);setOwnReply(null);setManagementError('暂时无法读取你的管理操作。');}},onSettled:()=>{if(sourceCurrent(source))setManagementReading(false);}});
  }
  async function loadParent(source=detailSource.current,quiet=false){
    if(!client||!source?.replyId||!source.versionId){setParentReading(false);return;}
    return detailReads.run({lane:'parent',key:source.key},()=>client.version(source.postId,source.versionId!),{validUntil:sourceReadDeadline,onStart:()=>{if(!quiet)setParentReading(true);setParentError('');},onSuccess:value=>{if(sourceCurrent(source))setParent(value);},onError:()=>{if(sourceCurrent(source)){setParent(null);setParentError('暂时无法读取原帖。');}},onSettled:()=>{if(sourceCurrent(source))setParentReading(false);}});
  }
  const refresh=async(initial?:{first:Awaited<ReturnType<typeof firstForumRead>>;ticket:number},quiet=false)=>{
    if(!client||!current()||!connected&&(reportId||!postId&&!replyId&&!memberSectionId&&privatePage))return;
    if(!quiet)setReading(true);
    const ticket=initial?.ticket??++readEpoch.current,valid=()=>current()&&ticket===readEpoch.current,startedAt=Math.floor(Date.now()/1000);
    try{
      const outcome=initial?{status:'success' as const,value:initial.first}:await readFirst(!quiet);if(!valid()||outcome.status==='superseded')return;if(outcome.status==='error')throw outcome.error;const first=outcome.value;
      if(first.kind==='section'){const page=await readPages<ForumCardView>(after=>client.posts({...listQuery,sectionId:first.value.sectionId,...(after?{after}:{})}),feedPages.current,valid);if(page&&valid()){setSectionDetail(first.value);setItems(page.items);setNext(page.nextAfter);setError('');}}
      else if(first.kind==='sections'){const page=await readPages(after=>client.sections(after?{after}:{}),feedPages.current,valid,first.value);if(page&&valid()){setMemberSections(page.items);setNext(page.nextAfter);setError('');}}
      else if(first.kind==='notifications'){const page=await readPages(after=>client.notifications(after?{after}:{}),feedPages.current,valid,first.value);if(page&&valid()){setNotifications(leaseNotices(page.items,startedAt));setNext(page.nextAfter);setError('');}}
      else if(first.kind==='report'){setReportDetail(first.value);setError('');}
      else if(first.kind==='reply'||first.kind==='post'){
        let value:ForumPostView|null=first.kind==='post'?first.value:null;
        const reply=first.kind==='reply'?first.value:null;
        if(value&&postId&&!versionId&&value.currentVersionId)value=await client.version(postId,value.currentVersionId);
        if(!valid())return;
        const sourcePostId=reply?reply.locator.postId:value?.locator.postId,sourceVersionId=reply?reply.locator.postVersionId:value?.locator.versionId;
        if(!sourcePostId)return;
        const source:DetailSource={key:JSON.stringify([sourcePostId,sourceVersionId??null,reply?.locator.replyId??null]),postId:sourcePostId,versionId:sourceVersionId??null,replyId:reply?.locator.replyId??null,managePost:!!(manage&&connected&&postId),ownReply:!!(reply&&connected&&owns(reply))};
        if(detailSource.current?.key!==source.key){detailReads.cancel();discussionAppend.current=false;replyPages.current=1;setParent(null);setVersions([]);setVersionNext(null);setReplies([]);setReplyNext(null);setOwnPost(null);setOwnReply(null);setVersionsError('');setRepliesError('');setManagementError('');setParentError('');}
        detailSource.current=source;setDetail(value);setReplyDetail(reply);setError('');setReading(false);
        void loadVersions(source,quiet);void loadDiscussion(source,undefined,quiet);void loadManagement(source,quiet);void loadParent(source,quiet);
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
    working.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (reason) { if (current()) { displayError(reason); setFocusTarget('error'); } }
    finally { if (current()) { try { await readPending(); } catch (reason) { if (current()) displayError(reason); } if (current()) { working.current = false; setBusy(false); } } }
  }
  async function begin(kind: ForumKind, target: ForumDraftTarget = {}, values: ForumDraftValues = {}) {
    if (!accountReady)return;
    if (!client) return;
    if (formRef.current) throw Error('这里已有本机稿。先继续它，或明确取消编辑，再开始另一份。');
    const value = newForumDraft(kind, target, values), saved = await client.draft.save(value);
    if (current()) { formRef.current = saved; setForm(saved); setEditorOpen(true);setDiscardDraft(false);setRetryPreview(null); setSaveFailed(false); setSaveMessage('草稿已保存。'); setFocusTarget('editor'); }
  }
  function change<K extends keyof ForumDraftValues>(field: K, value: ForumDraftValues[K]) {
    if (!client || !formRef.current || busy || draftLoading||!current()) return;
    try { client.check(); } catch (reason) { displayError(reason); return; }
    const nextForm = { ...formRef.current, [field]: value, revision: formRef.current.revision + 1 };
    formRef.current = nextForm; setForm(nextForm); setSaveMessage('正在保存…');
    void client.draft.save(nextForm).then(() => { if (current() && formRef.current === nextForm) { setSaveFailed(false); setSaveMessage('已保存。'); } })
      .catch((reason: unknown) => { if (current()) { setSaveFailed(true); setSaveMessage(forumError(reason)); } });
  }
  async function saveAttachments(attachments:ForumDraftAttachment[]){
    if(!client||!formRef.current||busy||formRef.current.operationId||!current())throw new DOMException('Draft changed','AbortError');
    const next={...formRef.current,attachments,revision:formRef.current.revision+1};formRef.current=next;setForm(next);setSaveMessage('正在保存…');
    try{await client.draft.save(next);if(current()&&formRef.current===next){setSaveFailed(false);setSaveMessage('已保存。');}}
    catch(reason){if(current()){setSaveFailed(true);setSaveMessage(forumError(reason));}throw reason;}
  }
  async function configForDraft(value: ForumDraft) {
    if (!client) return null;
    if (value.kind === 'create-report') return client.reportConfig({ target: forumSourceTargetFromDraft(value) });
    if (['supplement', 'withdraw-report', 'appeal', 'resolve'].includes(value.kind)) {
      const report = await client.report(forumTargetString(value.target.reportId)), config = await client.reportConfig({ target: report.target });
      return { ...config, report,operationsHandling:report.operationsHandling===true,operationsDisclosure:report.operationsDisclosure };
    }
    return null;
  }
  async function prepare(selectedAt:number) {
    if (!client || !formRef.current) return;
    if(!connected){await login('login');return;}
    const originalForm = formRef.current;
    await client.draft.flush();
    if (!current() || formRef.current !== originalForm) return;
      if(originalForm.kind==='create-post'&&!forumTopics.some(topic=>topic.id===originalForm.topic))throw Error('请选择这篇帖子的主题。');
      if((originalForm.kind==='create-post'||sectionWrite(originalForm.kind))&&!originalForm.audience)throw Object.assign(Error('forum_audience_required'),{code:'forum_audience_required'});
    if(typeof originalForm.target.accountId==='string'&&originalForm.target.accountId!==account?.id)throw Object.assign(Error('official_account_changed'),{code:'official_account_changed'});
    if(publicWrite(originalForm.kind))for(const attachment of originalForm.attachments){
      const actual=await client.attachments.read(attachment.id);
      if(actual.attachmentId!==attachment.id||actual.sha256!==attachment.sha256||actual.state!=='available')throw Error('附件尚未就绪，请查看文件状态。');
    }
    let publicationDeadline:number|null=null,currentPolicy = policy;
    if (needsAccount(originalForm.kind)) {
      const result = await client.quotas(quotaTarget(originalForm));
      if (!current()) return;
      currentPolicy = result.policy;setPolicy({draftId:originalForm.id,value:result.policy});
      if(result.reason==='account_selection_required')throw Object.assign(Error('account_selection_required'),{code:'account_selection_required'});
      if (!result.accountVerified) throw Object.assign(Error(result.reason??'account_verification_required'), { code: result.reason??'account_verification_required' });
      if (result.publication)publicationDeadline=result.publication.maxPublishedUntil;

    }
    if (publicWrite(originalForm.kind) && (!currentPolicy || !Number.isSafeInteger(currentPolicy.maxPermissionSeconds) || currentPolicy.maxPermissionSeconds < 1))
      throw Error('暂时无法发表，请稍后重试。草稿保留。');
    if (originalForm.kind === 'create-reply') {
      const source = await client.version(forumTargetString(originalForm.target.postId), forumTargetString(originalForm.target.versionId));
      if (!isAvailable(source)) throw Error('原版当前不可读，不能向它新增回复。本机文字保留。');
      if(source.canParticipate===false)throw Object.assign(Error('forum_participation_denied'),{code:'forum_participation_denied'});
    }
    const config = await configForDraft(originalForm);
    if (!current() || formRef.current !== originalForm) return;
    if (config) setGovernance({draftId:originalForm.id,value:config});
    if(['create-report','supplement','appeal'].includes(originalForm.kind)&&(!governance||(config?.operationsHandling===true)!==(governance.operationsHandling===true)))throw Error('举报接收范围已更新，请核对下方说明后再提交。');
    const knownAccountId=account?.id??null;
    const payload = forumPayload(originalForm.kind,forumDraftPayload({...originalForm,target:{...originalForm.target,...(knownAccountId?{accountId:knownAccountId}:{})}}, { maxPermissionSeconds: currentPolicy?.maxPermissionSeconds ?? 0, maxGovernanceHideSeconds: Math.min(config?.maxGovernanceHideSeconds ?? 0, config?.maxPermissionSeconds ?? 0) },selectedAt));
    if (publicWrite(originalForm.kind)) {
      if (!('publishedUntil' in payload)) throw Error('当前稿件不是可公开发表的内容。');
      payload.publishedUntil=publicationDeadline??selectedAt+(currentPolicy?.maxPermissionSeconds??0);

    }
    if(originalForm.kind==='resolve'&&!config?.report?.decisionRecipients)throw Error('当前处理接收人暂时无法核对，请保留这份说明。');
    if(originalForm.kind==='resolve'&&'accountViewers'in payload)payload.accountViewers=config?.report?.decisionAccountRecipients??[];
    else if(originalForm.kind==='resolve')Object.assign(payload,{accountViewers:config?.report?.decisionAccountRecipients??[]});
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
    if(kind==='update-section'&&result.locator?.sectionId===memberSectionId){await refresh(undefined,true);return;}
    if (['create-post', 'publish-version', 'create-reply', 'create-report','create-section','update-section'].includes(kind) && destination) { go(destination); return; }
    setNotice(kind.startsWith('withdraw-') ? '原撤回操作已确认。当前内容按最新状态读取。' : '原操作已确认。'); await refresh();
  }
  async function startVersion() {
    if (!client || !postId || !detail) return;
    const source = await client.version(postId,forumTargetString(detail.locator.versionId)), head = await client.post(postId);
    if (!current()) return;
    if (!isAvailable(source) || !owns(source)) throw Error('只能从当前可读的本人版本准备更新。');
    await begin('publish-version', { postId, expectedHeadVersion: head.headVersion, versionId: source.locator.versionId,versionNumber:source.locator.versionNumber,...(forumAuthorAccountId(source)?{accountId:forumAuthorAccountId(source)}:{}) },
      { title: source.payload.title, body: source.payload.body, linksText: source.payload.links.join('\n'),attachments:(source.payload.attachments??[]).map(reference=>forumAttachmentDraft({...reference,...source.attachments?.find(item=>item.attachmentId===reference.id),state:source.attachments?.find(item=>item.attachmentId===reference.id)?.state??'unavailable'},{existing:true})),topic:source.payload.topic??'unclassified',sectionId:source.sectionId??null,audience:source.audience });
  }
  async function withdraw(kind:'withdraw-post'|'withdraw-reply',value:ForumOwnedPost|ForumOwnedReply|ForumReplyView){
    if(!client||!current())return;
    if(kind==='withdraw-reply'){if(value.locator.kind!=='reply')throw Error('原回复记录不完整，请重新读取。');await begin(kind,{replyId:value.locator.replyId,...(forumAuthorAccountId(value)?{accountId:forumAuthorAccountId(value)}:{})});return;}
    if(!('headVersion'in value)||!Number.isSafeInteger(value.headVersion))throw Error('请从“我的帖子”重新读取本人记录，再选择撤回。');
    await begin(kind,{postId:value.locator.postId,expectedHeadVersion:value.headVersion,...(forumAuthorAccountId(value)?{accountId:forumAuthorAccountId(value)}:{})});
  }
  async function startReport(value: ForumContentView) { await begin('create-report', forumSourceTarget(value)); }
  const refreshLatest=useEffectEvent(refresh);
  useLayoutEffect(()=>{backgroundRead.current=(lane,value)=>{if(lane==='primary'&&current()){if(value===undefined)clearReading();else void refreshLatest({first:value as Awaited<ReturnType<typeof firstForumRead>>,ticket:++readEpoch.current},true);}};});
  const restoreInput=useEffectEvent(async(records:ForumPending[])=>{if(accountReady&&current()){setPending(records);await readDraft();await resumeQuietly();await readPending();}});
  const tickLatest=useEffectEvent(async()=>{
    if(document.hidden||working.current||!current())return;
    await resumeQuietly();if(current())await refresh(undefined,true);
  });
  const clearPrivateReading=useEffectEvent(clearReading);
  const readFailure=useEffectEvent((reason:unknown)=>{if(current())displayError(reason);});
  const initialFailure=useEffectEvent((reason:unknown,ticket:number)=>{if(current()&&ticket===readEpoch.current){clearReading();displayError(reason);setReading(false);}});
  const readFirstCurrent=useEffectEvent(readFirst);
  useEffect(()=>{
    const life=alive,readingVersion=readEpoch,draftVersion=draftEpoch;life.current=true;
    if(client&&current()&&(connected||!reportId&&(postId||replyId||memberSectionId||!privatePage))){const ticket=++readingVersion.current;
      void readFirstCurrent().then(outcome=>{if(outcome.status==='success')return refreshLatest({first:outcome.value,ticket});if(outcome.status==='error')initialFailure(outcome.error,ticket);}).catch(reason=>initialFailure(reason,ticket));
    }
    if(client&&accountReady&&current())void client.pending().then(restoreInput).catch(readFailure);
    const tick=()=>{if(!document.hidden){setNow(Math.floor(Date.now()/1000));void tickLatest().catch(readFailure);}};
    const visible=()=>{if(document.hidden)clearPrivateReading();else tick();};
    const offline=()=>{readingVersion.current++;clearPrivateReading();setReading(false);setError('网络已断开，草稿仍保留；恢复连接后重新读取允许的内容。');};
    document.addEventListener('visibilitychange',visible);
    window.addEventListener('offline',offline);window.addEventListener('online',tick);
    return()=>{life.current=false;readingVersion.current++;draftVersion.current++;document.removeEventListener('visibilitychange',visible);window.removeEventListener('offline',offline);window.removeEventListener('online',tick);client?.close();};
  },[client,current,connected,reportId,replyId,postId,versionId,memberSectionId,section,subjectId,listQuery,accountReady,privatePage]);
  const prepareDraft=useEffectEvent((draftId:string,active:()=>boolean)=>{
    const value=formRef.current;if(!client||!value||value.id!==draftId)return;
    const valid=()=>active()&&current()&&formRef.current?.id===draftId;
    if(needsAccount(value.kind))void client.quotas(quotaTarget(value)).then(result=>{if(valid())setPolicy({draftId,value:result.policy});}).catch(reason=>{if(valid())setPreparationError({draftId,reason});});
    if(!publicWrite(value.kind)&&!sectionWrite(value.kind)&&!value.kind.startsWith('withdraw-'))void configForDraft(value).then(result=>{if(result&&valid())setGovernance({draftId,value:result});}).catch(reason=>{if(valid())setPreparationError({draftId,reason});});
    if(publicWrite(value.kind)||sectionWrite(value.kind))void Promise.allSettled([client.accessOptions(),client.sections({limit:50})] as const).then(results=>{if(!valid())return;const options=results[0],sections=results[1];if(options.status==='fulfilled')setAccessOptions(options.value);if(sections.status==='fulfilled'){setSectionChoices(sections.value.items);setSectionChoiceNext(sections.value.nextAfter);}});
    if(value.kind==='create-reply')void client.version(forumTargetString(value.target.postId),forumTargetString(value.target.versionId)).then(source=>{if(valid())setDraftSourceRead({draftId,value:source});}).catch(reason=>{if(valid())setPreparationError({draftId,reason});});
  });
  const draftId=form?.id;
  useEffect(()=>{if(!client||!draftId)return;let active=true;if(connected)prepareDraft(draftId,()=>active);else void Promise.allSettled([client.accessOptions(),client.sections({limit:50})] as const).then(([options,sections])=>{if(!active||!current())return;if(options.status==='fulfilled')setAccessOptions(options.value);if(sections.status==='fulfilled'){setSectionChoices(sections.value.items);setSectionChoiceNext(sections.value.nextAfter);}});return()=>{active=false;};},[client,draftId,connected,current]);
  const autoCompose=useEffectEvent(async()=>{
    if(!compose||composeStarted.current||!accountReady||draftLoading||!draftLoaded||!client||!current())return;
    composeStarted.current=true;if(formRef.current||working.current)return;working.current=true;
    try{await begin('create-post',{},selectedTopic?{topic:selectedTopic.id}:{});}finally{working.current=false;}
  });
  useEffect(()=>{void autoCompose().catch(readFailure);},[compose,subjectId,draftLoading,draftLoaded,client,accountReady]);
  const autoReply=useEffectEvent(async()=>{
    if(replyStarted.current||new URLSearchParams(location.search).get('reply')!=='1'||!accountReady||!draftLoaded||formRef.current||!isAvailable(detail)||detail.canParticipate===false||!postId||working.current||!current())return;
    replyStarted.current=true;working.current=true;
    try{await begin('create-reply',{postId,versionId:detail.locator.versionId,versionNumber:detail.locator.versionNumber});}
    finally{working.current=false;}
  });
  const detailVersionId=detail?.locator.versionId;
  useEffect(()=>{void autoReply().catch(readFailure);},[connected,subjectId,draftLoaded,detailVersionId,accountReady]);
  const selected = replyId ? parent : detail;
  const selectedId = selected?.locator?.versionId;
  const selectedNumber=selected?.locator.versionNumber;
  const earlierVersion=!!selected?.currentVersionId&&selected.currentVersionId!==selectedId;
  const displayNames=useMemberNames(runtime,localSubjectId,localConnected,[...items.map(item=>item.authorId),detail?.authorId,replyDetail?.authorId,parent?.authorId,...replies.map(item=>item.authorId),...(retryPreview?.viewers??[])]);
  const owns=(value:ForumAuthorFields|null)=>forumOwnsContent(value,{accountId:account?.id??null});
  const own = owns(detail);
  const author=(value:ForumAuthorFields)=>{const id=forumAuthorSubjectId(value),accountId=forumAuthorAccountId(value);
    if(!accountId&&id)return <MemberLink subjectId={id} name={memberName(id,localSubjectId,displayNames[id]??undefined)} ownId={localSubjectId} navigate={go} avatar/>;
    const label=owns(value)?'我':value.author?.displayName?.trim()||(value.author?.uid?'银河账户 · '+value.author.uid:'银河账户');
    const content=<><AccountProfileAvatar name={value.author?.displayName||label} avatarKey={value.author?.avatarKey} subjectType={value.author?.subjectType} seed={accountId} size={28}/><span>{label}</span></>;return accountId?<ForumLink target={'/app/accounts/'+accountId} navigate={go} className="member-profile-link forum-account-author">{content}</ForumLink>:<span className="member-profile-link forum-account-author">{content}</span>;};
  const actingAccountName=official.session?.account.displayName||official.session?.account.email||'当前账户';
  const pendingActive = pending.find(item => item.state === 'awaiting-receipt');
  const recoveryNeedsReview=['authorization-expired','original-binding-changed','original-binding-unavailable','authorization-review-required'].includes(pendingReason);
  const editorTitle=form?(form.kind==='create-post'?'写帖子':form.kind==='publish-version'?'编辑帖子':labels[form.kind]):'写帖子';
  async function login(mode:'login'|'register'){
    if(!official.client)throw Error('账户服务暂不可用，请重新读取。');
    await client?.draft.flush();if(!current())return;
    if(!account&&formRef.current)rememberForumLoginDraft({endpoint:runtime!.api.endpoint,context,path:location.pathname+location.search+location.hash,draft:formRef.current});
    location.assign(official.client.loginUrl(mode,location.pathname+location.search+location.hash));
  }
  const accountEntry=<div className="forum-account-entry" aria-label="当前操作账户">{official.phase==='loading'?<output>正在读取账户…</output>:account?<p><strong>{official.session?.account.displayName||official.session?.account.email||'已登录银河账户'}</strong></p>:<><p>{official.phase==='offline'?'暂时离线，草稿保留。':official.phase==='unavailable'?'账户暂时无法读取，草稿保留。':'登录后继续，草稿会保留。'}</p>{official.client&&<div className="button-row"><a href={official.client.loginUrl('login',location.pathname+location.search+location.hash)} onClick={event=>{event.preventDefault();void run(()=>login('login'));}}>登录</a><a href={official.client.loginUrl('register',location.pathname+location.search+location.hash)} onClick={event=>{event.preventDefault();void run(()=>login('register'));}}>注册</a></div>}{(official.phase==='unavailable'||official.phase==='offline')&&<Button variant="outline" onClick={()=>void official.refresh()}>重试</Button>}</>}</div>;
  async function loadMore(focus=false) {
    if(!client||!next)return;
    if(memberSectionId){const page=await client.posts({...listQuery,sectionId:memberSectionId,after:next});if(current()){feedPages.current++;setItems(old=>[...old,...page.items]);setNext(page.nextAfter);}}
    else if(section==='sections'){const page=await client.sections({after:next});if(current()){feedPages.current++;setMemberSections(old=>[...old,...page.items]);setNext(page.nextAfter);}}
    else if(section==='notifications'){const startedAt=Math.floor(Date.now()/1000),page=await client.notifications({after:next});if(current()){feedPages.current++;setNotifications(old=>[...old,...leaseNotices(page.items,startedAt)]);setNext(page.nextAfter);}}
    else if(section==='reports'){
      const page=await readPages(after=>client.reports({after:after??next}),1,current);
      if(page&&current()){feedPages.current+=page.pagesRead;setReportItems(old=>[...new Map([...old,...page.items].map(item=>[item.reportId,item])).values()]);setNext(page.nextAfter);}
    }else{
      const page=await readPages<ForumCardView>(after=>section==='owned'?client.owned({...listQuery,after:after??next}):client.posts({...listQuery,after:after??next}),1,current);
      if(page&&current()){
        feedPages.current+=page.pagesRead;setItems(old=>[...new Map([...old,...page.items].map(item=>[item.locator.postId,item])).values()]);setNext(page.nextAfter);
        const addedId=page.items.find(item=>!items.some(previous=>previous.locator.postId===item.locator.postId))?.locator.postId;
        if(addedId&&focus)requestAnimationFrame(()=>{if(current())document.querySelector<HTMLElement>('#forum-post-'+addedId+' h2 a')?.focus({preventScroll:true});});
      }
    }
  }
  const loadMoreCurrent=useEffectEvent(()=>run(()=>loadMore()));
  useEffect(()=>{if(!next||!moreFeed.current)return;const observer=new IntersectionObserver(entries=>{if(entries.some(value=>value.isIntersecting)&&!working.current)void loadMoreCurrent();},{rootMargin:'300px'});observer.observe(moreFeed.current);return()=>observer.disconnect();},[next,busy]);
  const morePosts=<div ref={moreFeed} className="forum-load-more">{next&&<Button variant="ghost" disabled={busy} onClick={()=>run(()=>loadMore(true))}>更多内容</Button>}</div>;
  async function readMoreReplies(){if(replyNext)await loadDiscussion(detailSource.current,replyNext);}
  const readRepliesCurrent=useEffectEvent(readMoreReplies);
  useEffect(()=>{if(!replyNext||!moreReplies.current)return;const observer=new IntersectionObserver(entries=>{if(entries.some(value=>value.isIntersecting)&&!working.current&&!repliesReading)void readRepliesCurrent();},{rootMargin:'250px'});observer.observe(moreReplies.current);return()=>observer.disconnect();},[replyNext,busy,repliesReading]);
  async function readNotice(value:ForumNotification,open=false){try{await client!.readNotification(value.replyId);if(current()){setNotifications(old=>old.map(item=>item.replyId===value.replyId?{...item,read:true}:item));if(open)go(forumVersionPath(value.postId,value.postVersionId)+'#reply-'+value.replyId);}}catch(reason){if(current())setNotifications(old=>old.filter(item=>item.replyId!==value.replyId));throw reason;}}
  function resumeDraft(){setEditorOpen(true);setDiscardDraft(false);setFocusTarget('editor');}
  async function keepDraft(){await client!.draft.flush();if(!current())return;setEditorOpen(false);setDiscardDraft(false);setNotice('草稿已留在此浏览器，可以稍后继续。');if(compose)go(feedPath);}
  async function removeDraft(){const value=formRef.current;if(!value||value.operationId)return;if(await client!.draft.clear({id:value.id,revision:value.revision})){if(current()&&formRef.current===value){formRef.current=null;setForm(null);setDiscardDraft(false);setEditorOpen(false);setNotice('这份未提交草稿已删除。');if(compose)go(feedPath);}}else throw Error('草稿已变化，请先读取当前内容后再决定。');}
  async function beginSection(){await begin('create-section',{},{});}
  async function maintainSection(){if(!sectionDetail?.canMaintain)return;await begin('update-section',{sectionId:sectionDetail.sectionId,expectedVersion:sectionDetail.version,accountId:sectionDetail.maintainerAccountId},{title:sectionDetail.title,theme:sectionDetail.theme,description:sectionDetail.description,audience:sectionDetail.audience,sectionState:sectionDetail.state});}
  const audienceSection=form?.sectionId?(sectionDetail?.sectionId===form.sectionId?sectionDetail:sectionChoices.find(value=>value.sectionId===form.sectionId)):null;
  const draftSource=form&&draftSourceRead&&form.id===draftSourceRead.draftId?draftSourceRead.value:null;
  function chooseSection(value:ForumSection|null){if(!client||!formRef.current||busy)return;const draft=formRef.current;const changed={...draft,sectionId:value?.sectionId??null,...(!draft.audience&&value?{audience:value.audience}:{}),revision:draft.revision+1};formRef.current=changed;setForm(changed);void client.draft.save(changed).then(()=>{if(current()){setSaveFailed(false);setSaveMessage('已保存。');}}).catch(reason=>{if(current()){setSaveFailed(true);setSaveMessage(forumError(reason));}});}
  function card(value: ForumCardView, owned = false) {
    const locator = value.locator, available = isAvailable(value), path = owned ? `/app/community/posts/${locator.postId}?manage=1` : targetPath(locator) ?? `/app/community/posts/${locator.postId}`;
    const category=available?forumTopics.find(item=>item.id===value.topic):null;
    return <article className="forum-card forum-content-row" id={'forum-post-'+locator.postId} key={locator.postId}>
      {available&&<ContentCover image={contentCoverFromLinks(value.payload.links??[],value.payload.title)} href={path} navigate={go}/>}
      <div className="forum-card-copy">
      <h2>{link(path, available ? value.payload.title : 'state'in value&&value.state==='withdrawn'?'已撤回的帖子':'当前不可读取的帖子')}</h2>
      {available ? <p className="forum-excerpt">{forumBodyExcerpt(value.payload.body)}</p> : <p>{states[value.availability??''] ?? '当前没有可展示的正文。'}</p>}
      <div className="forum-meta">{author(value)}<PostTime createdAt={value.createdAt} updatedAt={available?value.versionCreatedAt:undefined}/>{available&&link(forumBrowsePath({topic:category?.id??'unclassified'}),category?.label??'未分类','forum-topic-label')}</div>
      {available&&<ForumAudienceSummary value={value.audience} options={accessOptions}/>}
      <div className="forum-card-footer">{link(path, <><MessageCircle size={14}/>阅读与讨论</>)}{available&&value.payload.links?.length>0&&<span>{value.payload.links.length} 个相关链接</span>}</div>
      </div>
    </article>;
  }
  const displayReply = (value: ForumReplyView) => <article ref={replyId===value.locator.replyId?primaryContent:undefined} className="forum-reply forum-discussion-reply" id={'reply-' + value.locator.replyId} key={value.locator.replyId}>
    <div className="forum-meta">{author(value)}<PostTime createdAt={value.createdAt}/>{isAvailable(value)&&<ForumAudienceSummary value={value.audience} options={accessOptions} inherited={value.audienceInherited}/>} {link(forumReplyPath(value.locator.replyId)!, '查看此条')}</div>
    {isAvailable(value) ? <>{value.payload.replyTo && <p className="reply-context">回复 {link(forumReplyPath(value.payload.replyTo.replyId)!, '先前的讨论')}</p>}<Body body={value.payload.body} code/>{client&&<ForumAttachmentFiles key={value.locator.replyId} client={client.attachments} items={value.attachments??[]} source={{replyId:value.locator.replyId}}/>}</> : <p>{states[value.availability] ?? '当前无法读取这条回复。'}</p>}
    {isAvailable(value) && <div className="button-row">{isAvailable(selected)&&selected.canParticipate!==false&&value.canParticipate!==false && <Button variant="ghost" disabled={busy || !!form} onClick={() => run(() => begin('create-reply', { postId: value.locator.postId, versionId: value.locator.postVersionId,versionNumber:selectedNumber }, { replyTo: { replyId: value.locator.replyId, contentRevision: 1 } }))}>回复此条</Button>}
      {owns(value) ? <Button variant="ghost" disabled={busy || !!form} onClick={() => run(() => withdraw('withdraw-reply', value))}>撤回我的回复</Button> : <Button variant="ghost" disabled={busy || !!form} onClick={() => run(() => startReport(value))}>私有举报</Button>}</div>}
  </article>;

  return <section className={'forum-workspace'+(postFeed?' forum-discovery':'')} aria-busy={busy}>
    {privatePage&&!connected&&accountEntry}
    <OfficialAccountLoginNotice search={routeSearch}/>
    {isFeed&&<><div className="forum-heading"><div><h1 id={fieldId+'-heading'} className="small" style={{overflowWrap:'anywhere'}}>{feedTitle}</h1><p>{feedDescription}</p></div></div><SelectionRail active={section+topic} className="forum-tabs" aria-label="社区内容">{link(forumBrowsePath({topic,query}),'银河讨论',undefined,postFeed,'tabs')}{link('/app/community?section=sections','成员版块',undefined,section==='sections','tabs')}{link('/app/community?section=notifications','回复提醒',undefined,section==='notifications','tabs')}{link(communityBrowsePath({topic,query,source:'external'}),'外部精选',undefined,false,'tabs')}{section==='owned'&&link('/app/community?section=reports','内容处理记录','forum-reports-link')}{section==='reports'&&<span className="active">举报与处理</span>}</SelectionRail></>}
    {!isFeed&&link(returnPath,<>返回{returnLabel}</>,'back-link')}
    {!isFeed&&(memberSectionId?!sectionDetail:compose||reportId||replyId||!isAvailable(detail))&&<div className="forum-heading"><h1 className="small">{memberSectionId?'版块详情':compose?editorTitle:reportId?'处理记录详情':replyId?'回复详情':manage?'帖子管理':'帖子详情'}</h1></div>}
    {error && <div ref={actionError} tabIndex={-1} className="message error" role="alert">{error}<Button variant="ghost" disabled={busy} onClick={() => void refresh()}>重试</Button></div>}
    {notice && <output className="message">{notice}</output>}
    {form&&!editorOpen&&!draftLoading&&<aside className="forum-draft-return" aria-label="未提交的草稿"><div><strong>{form.kind==='publish-version'?'这篇帖子的修改尚未发表':form.kind==='create-reply'?'你有尚未发出的回复':'你有尚未提交的草稿'}</strong><p>{form.title||labels[form.kind]} · 仅保存在此浏览器</p></div><Button variant="outline" disabled={busy} onClick={resumeDraft}>继续编辑</Button></aside>}
    {visitorConflict&&<aside className="forum-draft-return" aria-label="登录前的草稿"><p>登录前的草稿仍保留在此浏览器。当前账户在这里已有另一份草稿，处理后可以接回原稿。</p><Button variant="outline" disabled={busy||!!form} onClick={()=>run(readDraft)}>接回登录前草稿</Button></aside>}
    {compose && accountReady && !form && !draftLoading && draftLoaded && <Button disabled={busy} onClick={() => run(() => begin('create-post',{},selectedTopic?{topic:selectedTopic.id}:{}))}>开始写这条帖子</Button>}
    {accountReady && !draftLoading && !draftLoaded && <Button variant="outline" disabled={busy} onClick={() => run(()=>readDraft())}>重试恢复草稿</Button>}
    <LoadingFeedback active={(!postFeed)&&reading&&!detail&&!replyDetail&&!reportDetail&&!sectionDetail&&!items.length&&!reportItems.length&&!memberSections.length&&!notifications.length} label="正在读取当前内容…" scopeKey={context}/>
    {isFeed&&section==='sections'&&<><div className="button-row"><Button disabled={busy||!!form||draftLoading} onClick={()=>void run(beginSection)}>创建讨论版块</Button></div><div className="forum-section-directory">{memberSections.map(value=><article className="forum-section-row" key={value.sectionId}><h2>{link('/app/community/sections/'+value.sectionId,value.title)}</h2><p>{value.theme}</p>{value.description&&<p className="forum-excerpt">{value.description}</p>}<div className="forum-section-meta">{link('/app/accounts/'+value.maintainerAccountId,'查看维护者')}{value.category&&<span>{forumTopics.find(topic=>topic.id===value.category)?.label??'未分类'}</span>}{value.state==='archived'&&<span>已归档</span>}{value.canMaintain&&<span>由你维护</span>}</div><ForumAudienceSummary value={value.audience} options={accessOptions}/></article>)}{!reading&&!error&&!memberSections.length&&<p className="empty-state">还没有可读版块。</p>}</div>{morePosts}</>}
    {memberSectionId&&sectionDetail&&<><header className="forum-section-heading"><p className="forum-section-meta">成员版块{sectionDetail.state==='archived'?' · 已归档':''}{sectionDetail.category?' · '+(forumTopics.find(topic=>topic.id===sectionDetail.category)?.label??'未分类'):''}</p><h1>{sectionDetail.title}</h1><p>{sectionDetail.theme}</p>{sectionDetail.description&&<Body body={sectionDetail.description}/>}<p>{link('/app/accounts/'+sectionDetail.maintainerAccountId,'版块维护者')}</p><ForumAudienceSummary value={sectionDetail.audience} options={accessOptions}/><div className="button-row">{sectionDetail.state==='active'&&(sectionDetail.canParticipate||!connected)&&<Button disabled={busy||!!form||draftLoading} onClick={()=>void run(()=>begin('create-post',{}, {sectionId:sectionDetail.sectionId,audience:sectionDetail.audience,...(sectionDetail.category&&sectionDetail.category!=='unclassified'?{topic:sectionDetail.category}:{})}))}>在此版块发帖</Button>}{sectionDetail.canMaintain&&<Button variant="outline" disabled={busy||!!form||draftLoading} onClick={()=>void run(maintainSection)}>维护版块</Button>}{link('/app/community?section=sections','全部成员版块')}</div>{sectionDetail.state==='archived'?<p>版块已停止接收新帖子，已有内容仍按各自许可读取。</p>:connected&&!sectionDetail.canParticipate&&<p>当前账户可以阅读此版块，但不符合它的参与条件。</p>}</header><div className="forum-feed">{items.map(value=>card(value))}{!reading&&!error&&!items.length&&<p>这里还没有当前可读取的帖子。</p>}{morePosts}</div></>}
    {isFeed&&section==='notifications'&&<><ul className="forum-notifications">{notifications.filter(value=>noticeDeadline(value)>now).map(value=><li key={value.replyId} data-unread={!value.read||undefined}><p className="forum-meta">{value.read?'已读':'新回复'} · {new Date(typeof value.at==='number'?value.at*1000:value.at).toLocaleString('zh-CN')}</p><h2>{value.title}</h2><div className="forum-meta">{author(value)}</div><p>{value.preview}</p><div className="button-row"><Button variant="outline" disabled={busy} onClick={()=>void run(()=>readNotice(value,true))}>阅读这条回复</Button>{!value.read&&<Button variant="ghost" disabled={busy} onClick={()=>void run(()=>readNotice(value))}>标为已读</Button>}</div></li>)}</ul>{!reading&&!error&&connected&&!notifications.some(value=>noticeDeadline(value)>now)&&<p className="empty-state">暂时没有新回复。</p>}{!connected&&<p className="muted">登录银河账户后查看与你有关的回复。</p>}{morePosts}</>}
    {postFeed&&<div className="forum-discovery-layout">
      <section className="forum-results" aria-labelledby={fieldId+'-heading'}>
        <div className="forum-feed-toolbar"><span className="forum-order-label">{feedOrder==='published'?'最新发表':feedOrder==='id'?'服务默认顺序':'银河讨论'}</span>{section==='owned'?link(forumBrowsePath({topic,query}),'浏览所有讨论'):link(forumBrowsePath({section:'owned',topic,query}),'我的帖子')}</div>
        <search><form className="forum-search" onSubmit={event=>{event.preventDefault();go(forumBrowsePath({section,topic,query:queryInput}),'results');}}><label htmlFor={fieldId+'-search'}><span className="forum-search-label">搜索帖子</span><Input id={fieldId+'-search'} type="search" aria-label="搜索帖子" maxLength={160} value={queryInput} onChange={event=>setQueryInput(event.target.value)} placeholder={topic?'在当前主题中搜索标题或正文':'搜索帖子标题或正文'}/></label><Button type="submit" variant="outline"><Search size={16} aria-hidden/>搜索</Button></form></search>
        {query&&<div className="forum-search-context">{link(forumBrowsePath({section,topic}),'清除搜索','text-link',false,'results')}</div>}
        <div className="forum-feed" aria-busy={reading}>
          {items.map(value=>card(value,section==='owned'))}
          <LoadingFeedback active={reading&&!items.length} label="正在读取帖子…" scopeKey={feedPath}/>
          {!reading&&!error&&!items.length&&(section==='all'||connected)&&<div className="forum-result-empty"><h3 tabIndex={-1}>{query?'没有找到相符的帖子':section==='owned'?'这里还没有你的帖子':topic?'这个主题还没有可读的帖子':'社区还没有可读的帖子'}</h3><p>{query?'可以换一个词，或清除搜索继续浏览。':section==='owned'?'发表后，可以在这里找到并继续自己的内容。':'可以浏览其他主题，也可以写下自己的第一段内容。'}</p><div className="button-row">{query?link(forumBrowsePath({section,topic}),'清除搜索','text-link',false,'results'):topic?link(forumBrowsePath({section}),'浏览全部帖子','text-link',false,'topic'):null}{!query&&<Button variant="outline" onClick={()=>go(forumBrowsePath({section,topic,compose:true}))}>写一条帖子</Button>}{link(communityBrowsePath({source:'external',topic,query}),'看看外部精选','text-link')}</div></div>}
          {morePosts}
        </div>
      </section>
      <CommunityReadingSidebar key={(runtime?.api.endpoint??'')+':'+(subjectId??'visitor')} runtime={runtime} subjectId={subjectId} navigate={go} posts={section==='all'?items:[]}/>
    </div>}
    {isFeed&&section==='reports'&&<div className="forum-feed">{reportItems.map(item=><article className="forum-card" key={item.reportId}><h2>{link(`/app/community/reports/${item.reportId}`, '查看我的举报或受影响记录')}</h2><p>{item.state==='pending'?'已登记，尚待处理。':'有新的处理记录，可按当前权限查看。'}</p>{item.canAppeal&&<span className="tag">可以提交申诉</span>}</article>)}{!reading&&!error&&!reportItems.length&&connected&&<div className="empty-state">暂无处理记录。</div>}{morePosts}</div>}

    {(postId&&detail||replyId&&replyDetail) && <>
      {replyId&&replyDetail ? <><div className="forum-parent-link">{link(forumVersionPath(replyDetail.locator.postId, replyDetail.locator.postVersionId)!,<>{isAvailable(parent)?parent.payload.title:'查看原帖'}</>)}<LoadingFeedback active={parentReading} label="正在读取原帖…" scopeKey={detailSource.current?.key??context}/>{parentError&&<ReadFailure message={parentError} onRetry={()=>void loadParent()} retrying={parentReading}/>}{parent&&!isAvailable(parent)&&<p>原帖当前不可读取。</p>}</div>{displayReply(replyDetail)}</> : detail&&<article ref={primaryContent} className="forum-post">
        <div className="forum-meta">{author(detail)}<PostTime createdAt={detail.createdAt} updatedAt={isAvailable(detail)?detail.versionCreatedAt:undefined}/>{isAvailable(detail)&&link(forumBrowsePath({topic:detail.topic??'unclassified'}),forumTopics.find(topic=>topic.id===detail.topic)?.label??'未分类','forum-topic-label')}</div>
        {isAvailable(detail) ? <><h1>{detail.payload.title}</h1><ForumAudienceSummary value={detail.audience} options={accessOptions}/>{detail.sectionId&&<p className="forum-section-meta">{link('/app/community/sections/'+detail.sectionId,'所在成员版块')}</p>}{(earlierVersion||versions.length>1)&&<div className="forum-version-context"><p>{earlierVersion?'正在阅读较早发表的内容':detail.currentVersionId===selectedId?'正在阅读最新发表的内容':'正在阅读这次发表的内容'}{selectedNumber? ' · 第 '+selectedNumber+' 版':''}。这里的回复保留在这次发表的内容下。</p>{earlierVersion&&link(forumVersionPath(postId!,detail.currentVersionId)!,'阅读更新后的内容','text-link')}</div>}<div className="forum-post-body"><Body body={detail.payload.body} code/><Links links={detail.payload.links} titled/>{client&&selectedId&&<ForumAttachmentFiles key={selectedId} client={client.attachments} items={detail.attachments??[]} source={{postId:detail.locator.postId,versionId:selectedId}}/>}</div></> : <div className="empty-state">{states[detail.availability] ?? '暂时无法读取，请稍后重试。'}</div>}
        {isAvailable(detail) && <div className="forum-post-actions"><Button disabled={busy || !!form || detail.canParticipate===false} onClick={() => run(() => begin('create-reply', { postId, versionId: selectedId, versionNumber: detail.locator.versionNumber }))}><MessageCircle size={16} />回复</Button>
          <SaveForLaterButton runtime={runtime} account={official} subjectId={localSubjectId} connected={localConnected} reference={{kind:'forum-post',postId:detail.locator.postId}} onNeedIdentity={()=>go('/app/account')}/>
          {own && <Button variant="ghost" disabled={busy || !!form} onClick={() => run(()=>startVersion())}>编辑帖子</Button>}
          <button className="forum-options-toggle" aria-haspopup="dialog" onClick={()=>setPostOptions(true)}>帖子资料</button></div>}
        {isAvailable(detail)&&selectedId&&<AgentWorkContinuation runtime={runtime} subjectId={localSubjectId} object={{kind:'post',id:detail.locator.postId,versionId:selectedId}} title={detail.payload.title} purpose="接着阅读这次发表的内容，围绕我的问题理解、整理或准备回应" onNeedIdentity={()=>go('/app/settings/identity')}/>}
        {postOptions&&<ReadingSurface open title="帖子资料" onClose={()=>setPostOptions(false)}><section className="forum-post-details" aria-label="帖子资料"><h2>版本与相关操作</h2><LoadingFeedback active={versionsReading} label="正在读取版本记录…" scopeKey={detailSource.current?.key??context}/>{versionsError&&<ReadFailure message={versionsError} onRetry={()=>void loadVersions()} retrying={versionsReading}/>}<nav className="forum-versions" aria-label="帖子版本">{versions.map(value=>link(forumVersionPath(postId!,value.locator.versionId)!,`版本 ${value.locator.versionNumber}${value.locator.versionId===selectedId?' · 正在阅读':''}`))}{versionNext!==null&&<Button variant="ghost" disabled={busy||versionsReading} onClick={()=>{versionPages.current++;void loadVersions();}}>更早版本</Button>}</nav><p className="muted">{detail.publishedUntil&&<>此版可读取至 {date(detail.publishedUntil)}。</>}各次更新保留相应讨论。</p><div className="button-row">
          <Button variant="ghost" disabled={busy} onClick={() => run(async () => { const value = await client!.version(postId!,forumTargetString(selectedId)); if (!isAvailable(value)) throw Error('此版本当前不可读，不能继续采用它准备任务。'); if (current()) go(forumTaskPath({ postId, versionId: selectedId, returnTo: location.pathname + location.hash },{selectMaterial:!!localSubjectId&&value.authorId===localSubjectId})); })}>为这件事准备任务</Button>
          {!own&&<Button variant="ghost" disabled={busy||!!form} onClick={()=>{setPostOptions(false);void run(()=>startReport(detail));}}>举报</Button>}{own&&link(`/app/community/posts/${postId}?manage=1`,'管理我的版本')}</div></section></ReadingSurface>}
      </article>}
      <LoadingFeedback active={managementReading} label="正在读取你的管理操作…" scopeKey={detailSource.current?.key??context}/>{managementError&&<ReadFailure message={managementError} onRetry={()=>void loadManagement()} retrying={managementReading}/>}
      {replyId&&ownReply&&ownReply.state!=='withdrawn'&&(!isAvailable(replyDetail)||!owns(replyDetail))&&<div className="forum-owner-actions"><Button variant="ghost" disabled={busy||!!form} onClick={()=>run(()=>withdraw('withdraw-reply',ownReply))}>撤回我的回复</Button></div>}
      {ownPost && <section className="forum-card" aria-label="本人帖子管理"><h2>管理帖子</h2><div className="button-row">{ownPost.state !== 'withdrawn' && <><Button disabled={busy || !!form} onClick={() => run(() => isAvailable(detail)?startVersion():begin('publish-version', { postId, expectedHeadVersion: ownPost.headVersion,...(forumAuthorAccountId(ownPost)?{accountId:forumAuthorAccountId(ownPost)}:{}) },{audience:ownPost.audience,sectionId:ownPost.sectionId}))}>编辑内容</Button><Button variant="outline" disabled={busy || !!form} onClick={() => run(() => withdraw('withdraw-post', ownPost))}>撤回整条帖子</Button></>}</div>
        {ownPost.versionLocators.map((value) => <article className="forum-reply" key={value.locator.versionId}><h3>{link(forumVersionPath(postId!, value.locator.versionId)!, `第 ${value.locator.versionNumber} 版`)}</h3><p>读取许可至 {date(value.publishedUntil)}。{value.availability !== 'available' && (states[value.availability] ?? '当前不可读。')}</p><div className="button-row">{value.state !== 'withdrawn' && ownPost.state !== 'withdrawn' && <Button variant="outline" disabled={busy || !!form} onClick={() => run(() => begin('withdraw-version', { postId, versionId: value.locator.versionId, expectedHeadVersion: ownPost.headVersion,...(forumAuthorAccountId(ownPost)?{accountId:forumAuthorAccountId(ownPost)}:{}) }))}>撤回此版</Button>}</div></article>)}<PermissionDetail value={permission} />
      </section>}
      {!replyId&&detail&&<section className="forum-replies" aria-label="这版帖子的回复"><h2>{versions.length>1&&selectedNumber?'第 '+selectedNumber+' 版下的讨论':'讨论'}{replies.length>0&&<span>{replies.length}{replyNext?'+':''}</span>}</h2>{!isAvailable(detail)&&<p className="muted">原帖当前不可读，已有回复按各自的公开范围展示。</p>}{replies.map(displayReply)}<LoadingFeedback active={repliesReading} label="正在读取讨论…" scopeKey={detailSource.current?.key??context}/>{repliesError&&<ReadFailure message={repliesError} onRetry={()=>void loadDiscussion()} retrying={repliesReading}/>}{!repliesReading&&!repliesError&&!replies.length&&<p className="forum-discussion-empty">{isAvailable(detail)?'还没有回复，分享你的想法吧。':'暂无可查看的回复。'}</p>}<div ref={moreReplies}>{replyNext&&<Button variant="ghost" disabled={busy||repliesReading} onClick={()=>void readMoreReplies()}>更多回复</Button>}</div>{isAvailable(detail)&&detail.canParticipate!==false&&!form&&<button className="forum-reply-start" onClick={()=>run(()=>begin('create-reply',{postId,versionId:selectedId,versionNumber:detail.locator.versionNumber}))}><MemberAvatar subjectId={subjectId}/><span>写下你的回复…</span><MessageCircle size={18}/></button>}</section>}
      <footer className="forum-reading-return">{link(returnPath,<>继续浏览{returnLabel==='社区'?'社区帖子':returnLabel}</>)}</footer>
    </>}

    {reportId && reportDetail && <section className="forum-report"><h2>处理经过</h2><p>{reportDetail.state === 'pending' ? '等待处理' : '处理记录'}</p><p></p>
      {reportDetail.target && link(targetPath(reportDetail.target) ?? '/app/community', '查看原内容')}
      {(reportDetail.events ?? []).map((event) => <article className="forum-reply" key={event.governanceEventId ?? event.operationId}><h3>{event.kind === 'report' ? owns(event) ? '我的举报' : '获准查看的举报' : ({ supplement: '补充', withdraw: '撤回', appeal: '申诉', resolve: '处理决定' } as Record<string,string>)[event.kind] ?? '记录'}</h3>{(event.payload?.summary || event.payload?.reason) && <p className="forum-prose">{event.payload.summary ?? event.payload.reason}</p>}{event.payload?.resolution && <p>{({ dismissed: '不成立', accepted: '成立', 'needs-review': '需要进一步核对' } as Record<string,string>)[event.payload.resolution]}</p>}{event.payload?.effect?.until && <p>本次停止读取最迟至 {date(event.payload.effect.until)}，后续仍以当前许可和处理状态为准。</p>}{event.availability && event.availability !== 'available' && <p>这段私有文字当前不可读取。</p>}</article>)}
      <div className="button-row">{reportDetail.canSupplement && <Button disabled={busy || !!form} onClick={() => run(() => begin('supplement', { reportId, expectedReportVersion: reportDetail.version,...(reportDetail.actionAccountId?{accountId:reportDetail.actionAccountId}:{}) }))}>补充我的举报</Button>}{reportDetail.canWithdrawReport && <Button variant="outline" disabled={busy || !!form} onClick={() => run(() => begin('withdraw-report', { reportId, expectedReportVersion: reportDetail.version,...(reportDetail.actionAccountId?{accountId:reportDetail.actionAccountId}:{}) }))}>撤回我的举报</Button>}{reportDetail.canAppeal && <Button disabled={busy || !!form} onClick={() => run(() => begin('appeal', { reportId, expectedReportVersion: reportDetail.version,...(reportDetail.actionAccountId?{accountId:reportDetail.actionAccountId}:{}) }))}>提交申诉</Button>}{reportDetail.canModerate && <Button disabled={busy || !!form} onClick={() => run(() => begin('resolve', { reportId, expectedReportVersion: reportDetail.version,...(reportDetail.actionAccountId?{accountId:reportDetail.actionAccountId}:{}) }))}>记录处理决定</Button>}</div>
      {!reportDetail.events?.some((event) => event.payload?.summary) && <p className="muted">此入口只提供你获准查看的处理事实，举报者的私有文字不会因你是目标作者而公开。</p>}
    </section>}

    {accountReady && draftLoading && <output>正在恢复草稿…</output>}
    {accountReady && !draftLoading && form && editorOpen && <section ref={editor} className="forum-editor" aria-label="编辑内容">{!compose&&<h2>{editorTitle}</h2>}

      {publicWrite(form.kind)&&<div className="forum-draft-context">{form.kind==='publish-version'&&<p>正在编辑{form.target.versionNumber?'第 '+form.target.versionNumber+' 版':'已发表的内容'}。</p>}{form.kind==='create-reply'&&form.target.versionNumber&&<p>回复第 {form.target.versionNumber} 版的内容。</p>}</div>}
      {form.operationId && <p className="message">这份稿已关联原提交。先查询原结果或停止本机重试，再准备新的内容。</p>}
      <form className="workspace-form" onSubmit={event => { event.preventDefault(); const selectedAt=Math.floor(Date.now()/1000);void run(()=>prepare(selectedAt)); }}><fieldset disabled={busy || !!form.operationId}>
        {(['create-post', 'publish-version'].includes(form.kind)||sectionWrite(form.kind)) && <label htmlFor={fieldId+"-title"}>{sectionWrite(form.kind)?'版块名称':'标题'}<Input id={fieldId+"-title"} aria-label={sectionWrite(form.kind)?'版块名称':'标题'} required maxLength={sectionWrite(form.kind)?120:160} value={form.title} onChange={event => change('title', event.target.value)} placeholder="一句话说说你想分享的事" /></label>}
        {sectionWrite(form.kind)&&<><label htmlFor={fieldId+'-theme'}>讨论主题<Input id={fieldId+'-theme'} required maxLength={400} value={form.theme} onChange={event=>change('theme',event.target.value)} placeholder="在这个版块持续讨论什么"/></label><label htmlFor={fieldId+'-description'}>版块说明（可选）<Textarea id={fieldId+'-description'} maxLength={4000} value={form.description} onChange={event=>change('description',event.target.value)}/></label>{form.kind==='update-section'&&<label><input type="checkbox" checked={form.sectionState==='archived'} onChange={event=>change('sectionState',event.target.checked?'archived':'active')}/>归档版块，停止接收新帖子</label>}</>}
        {['create-post', 'publish-version', 'create-reply', 'create-report', 'supplement', 'appeal', 'resolve'].includes(form.kind) && <label htmlFor={fieldId+"-body"}>{publicWrite(form.kind) ? form.kind === 'create-reply' ? '回复内容' : '正文' : form.kind === 'appeal' ? '我的申诉说明' : form.kind === 'resolve' ? '我的处理理由' : '我的说明'}<Textarea id={fieldId+"-body"} aria-label={publicWrite(form.kind) ? form.kind === 'create-reply' ? '回复内容' : '正文' : form.kind === 'appeal' ? '我的申诉说明' : form.kind === 'resolve' ? '我的处理理由' : '我的说明'} required maxLength={form.kind === 'create-reply' ? 2000 : publicWrite(form.kind) ? 8000 : 1600} value={form.body} onChange={event => change('body', event.target.value)} placeholder={publicWrite(form.kind) ? '用自己的话写下来。' : '只写需要说明的事实，不复制目标的私有内容。'} /></label>}
        {publicWrite(form.kind)&&client&&<ForumAttachmentComposer key={form.id} client={client.attachments} draftId={form.id} value={form.attachments} onChange={saveAttachments} disabled={busy||!!form.operationId} canUpload={official.phase==='signed-in'} offline={official.phase==='offline'} onLogin={()=>{if(official.phase==='unavailable')void official.refresh();else void run(()=>login('login'));}} onBusyChange={setAttachmentWorking}/>}
        {['create-post','publish-version'].includes(form.kind)&&<div className="forum-publication-topic"><label htmlFor={fieldId+'-topic'}>发布到<select id={fieldId+'-topic'} aria-label="发布主题" required={form.kind==='create-post'} value={form.kind==='create-post'?(forumTopics.some(topic=>topic.id===form.topic)?form.topic:''):form.topic??'unclassified'} onChange={event=>change('topic',event.target.value?forumReadTopicSchema.parse(event.target.value):undefined)}>{form.kind==='create-post'?<option value="" disabled>选择一个主题</option>:<option value="unclassified">未分类</option>}{forumTopics.map(topic=><option key={topic.id} value={topic.id}>{topic.label}</option>)}</select></label></div>}
        {['create-post','publish-version'].includes(form.kind)&&<div className="forum-editor-tools"><Button type="button" variant="ghost" onClick={()=>setLinksEditor(true)}>{form.linksText.trim()?'编辑链接':'添加链接'}</Button>{linksEditor&&<ReadingSurface open title="相关链接" onClose={()=>setLinksEditor(false)}><label htmlFor={fieldId+'-links'}>每行一条，最多 8 条<Textarea id={fieldId+'-links'} value={form.linksText} maxLength={32768} onChange={event=>change('linksText',event.target.value)} placeholder="https://…"/></label><Button type="button" onClick={()=>setLinksEditor(false)}>完成</Button></ReadingSurface>}</div>}
        {['create-post','publish-version'].includes(form.kind)&&<section className="forum-section-post-choice" aria-label="发布位置"><Button type="button" variant="ghost" onClick={()=>setSectionPicker(true)}>{audienceSection?audienceSection.title:form.sectionId?'原所属版块':'社区讨论'} · 修改位置</Button>{sectionPicker&&<ReadingSurface open title="选择成员版块" onClose={()=>setSectionPicker(false)}><fieldset className="forum-section-post-choice"><legend>发布位置</legend><label><input type="radio" name={fieldId+'-section'} checked={!form.sectionId} onChange={()=>{chooseSection(null);setSectionPicker(false);}}/>社区讨论</label>{sectionChoices.map(value=><label key={value.sectionId}><input type="radio" name={fieldId+'-section'} checked={form.sectionId===value.sectionId} disabled={value.state!=='active'||connected&&!value.canParticipate&&value.sectionId!==form.sectionId} onChange={()=>{chooseSection(value);setSectionPicker(false);}}/><span><strong>{value.title}</strong><br/>{value.theme}{value.state==='archived'?' · 已归档':connected&&!value.canParticipate?' · 当前不满足参与条件':''}</span></label>)}{!sectionChoices.length&&<p>暂未读取到可选版块，可以直接发帖。</p>}{sectionChoiceNext&&<Button type="button" variant="outline" onClick={()=>void run(async()=>{const page=await client!.sections({after:sectionChoiceNext,limit:50});if(current()){setSectionChoices(old=>[...old,...page.items]);setSectionChoiceNext(page.nextAfter);}})}>继续读取版块</Button>}<Button type="button" variant="ghost" onClick={()=>setSectionPicker(false)}>取消</Button></fieldset></ReadingSurface>}</section>}
        {(publicWrite(form.kind)||sectionWrite(form.kind))&&<ForumAudienceEditor value={form.audience} onChange={value=>change('audience',value)} options={accessOptions} searchAccounts={client?.accounts} disabled={busy||!!form.operationId} inherited={form.kind==='create-reply'?(draftSource?.audience??(selected?.locator.versionId===form.target.versionId?selected?.audience:undefined)):form.kind==='publish-version'?detail?.audience:undefined} inheritedLabel={form.kind==='create-reply'?'沿用原帖范围':'沿用原有范围'} restrictedBySection={!!form.sectionId||!!(draftSource?.sectionId)}/>}
        {form.kind === 'create-report' && <><label>需要处理的问题<select aria-label="需要处理的问题" value={form.category} onChange={event => change('category',forumCategory(event.target.value))}>{categories.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>{governance?.operationsHandling&&<p className="muted">仅发送给运营处理人员。你选中的帖子版本或回复、问题类别和本次说明将用于处理举报。</p>}</>}
        {form.kind === 'resolve' && <><label>处理结果<select aria-label="处理结果" value={form.resolution} onChange={event => change('resolution',forumResolution(event.target.value))}><option value="needs-review">需要进一步核对</option><option value="dismissed">不成立</option><option value="accepted">成立</option></select></label><label><input aria-label="暂时停止目标内容读取" type="checkbox" checked={form.hide} onChange={event => change('hide', event.target.checked)} />暂时停止目标内容读取</label>{form.hide && <><label htmlFor={fieldId+"-hide"}>期望最长时数<Input id={fieldId+"-hide"} aria-label="期望最长时数" type="number" min={1 / 3600} max={24} step="any" value={form.hideHours} onChange={event => change('hideHours', Number(event.target.value))} /></label>{governance && <p>按当前规则，本次最长 {Math.floor(Math.min(form.hideHours * 3600, governance.maxGovernanceHideSeconds, governance.maxPermissionSeconds))} 秒。处理期限不会超过这份决定的有效许可。</p>}</>}</>}
      </fieldset>
      {publicWrite(form.kind) && <p className="forum-publication-note">以 {actingAccountName} 发表 · 可随时撤回</p>}
      {form.kind.startsWith('withdraw-') && <PreviewBody value={{ kind: form.kind, payload: {} }} />}
      {preparationError!==null&&preparationError!==undefined && <div className="message error" role="alert">{forumError(preparationError)}</div>}
      {form.kind === 'create-report' && governance && !governance.operationsHandling&&!governance.moderatorIds.length && <p>当前没有可接收此记录的处理者，将保留待处理状态，不承诺响应时间。</p>}
      {!form.operationId && !publicWrite(form.kind) && !sectionWrite(form.kind) && !form.kind.startsWith('withdraw-') && governance && <p className="muted">{form.kind === 'resolve' ? '这份独立处理理由会告知举报者和目标作者。' : governance.operationsHandling?'这份说明仅发送给运营处理人员，目标作者不会因此获得举报者说明。':`这份说明只向当前获准的 ${governance.moderatorIds.length} 位处理者披露，目标作者不会因此获得举报者说明。`} 私有内容按本次明确许可读取，最长 {Math.floor(governance.maxPermissionSeconds / 86400)} 天；记录被接受不代表已经解决。</p>}
      <div className="button-row"><Button type="submit" disabled={busy || attachmentWorking || form.attachments.some(item=>item.state!=='available') || !!form.operationId || !!pendingActive || saveFailed}>{!connected?'登录后继续':publicWrite(form.kind) ? '发表' : sectionWrite(form.kind)?'保存版块': form.kind.startsWith('withdraw-') ? '确认撤回' : form.kind === 'create-report' ? '提交私有举报' : form.kind === 'appeal' ? '提交申诉' : '提交私有记录'}</Button><Button type="button" variant="outline" disabled={busy||attachmentWorking} onClick={()=>run(keepDraft)}>暂存并返回</Button><button type="button" className="text-link" disabled={busy||attachmentWorking||!!form.operationId} onClick={()=>setDiscardDraft(true)}>放弃草稿</button></div></form>
      {discardDraft&&<div className="forum-discard-choice" role="alert"><p>删除这份尚未提交的草稿？已发表的内容会保留。</p><div className="button-row"><Button variant="outline" disabled={busy} onClick={()=>setDiscardDraft(false)}>保留草稿</Button><Button variant="ghost" disabled={busy} onClick={()=>run(removeDraft)}>删除这份草稿</Button></div></div>}
      <output className={saveFailed ? 'message error' : 'muted'}>{saveMessage}</output>
      {saveFailed && <Button variant="outline" disabled={busy} onClick={() => run(readDraft)}>重新读取本机版本</Button>}
    </section>}

    {pendingActive&&<section className="forum-pending-note" aria-label="发表状态"><p>{recoveryNeedsReview?'上次发表需要更新授权，内容已保留。':'正在确认发表结果，恢复连接后会自动继续。'}</p><div className="button-row">{recoveryNeedsReview&&<Button variant="outline" disabled={busy||!connected} onClick={()=>run(()=>reviewStored(pendingActive.operationId,pendingActive.kind))}>继续发表</Button>}<Button variant="ghost" disabled={busy} onClick={()=>run(async()=>{await client!.stopLocalRetry(pendingActive.operationId,{confirmed:true});await readDraft();if(!current())return;setRetryPreview(null);setPendingReason('');setNotice('已停止发送，已送达的内容保留。');})}>停止发送</Button></div></section>}
    <dialog ref={retryDialog} className="workspace-dialog forum-recovery-dialog" onCancel={event=>{if(busy)event.preventDefault();else setRetryPreview(null);}}>{retryPreview&&<><header className="dialog-heading"><h2>继续上次发表</h2><button type="button" className="icon-button" aria-label="关闭原内容预览" disabled={busy} onClick={()=>setRetryPreview(null)}>×</button></header><PreviewBody value={retryPreview}/><p>可见范围：{retryPreview.visibility==='Public'?('audience' in retryPreview.payload&&retryPreview.payload.audience?'按原受众条件':'按原内容许可'):retryPreview.viewers?.length?retryPreview.viewers.map((id:string)=>memberName(id,subjectId,displayNames[id]??undefined)).join('、'):'仅自己'}。</p>{retryPreview.expiresAt?<p>原授权期限：{date(retryPreview.expiresAt)}。</p>:<p className="message">原授权期限暂时无法确认。</p>}{Number.isSafeInteger(retryPreview.expiresAt)&&typeof retryPreview.expiresAt==='number'&&retryPreview.expiresAt<=now&&<p className="message">原许可已到期，这次原提交不能继续发送。</p>}{error&&<p role="alert" className="message error">{error}</p>}<div className="button-row"><Button disabled={busy||!Number.isSafeInteger(retryPreview.expiresAt)||typeof retryPreview.expiresAt==='number'&&retryPreview.expiresAt<=now} onClick={()=>run(async()=>{const chosen=retryPreview;const result=await client!.retry(chosen.operationId,{confirmed:true,reauthorize:true});if(current()){setPendingReason('');await finish(result,chosen.kind);}})}>按原内容继续</Button><Button variant="ghost" disabled={busy} onClick={()=>setRetryPreview(null)}>暂不继续</Button></div></>}</dialog>
  </section>;
}

export { CommunityTaskReturn } from "./task-return";
