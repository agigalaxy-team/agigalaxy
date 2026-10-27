"use client";
import {ReadingDetails,ReadingSummary} from "../shared/reading/reading-details";
import React,{lazy,Suspense} from "react";

import {Button} from "@/components/ui/button";
import {createWebRuntime} from "../runtime.mjs";

import {requesterFeedbackAvailable} from "../features/tasks/feedback/requester-feedback-client.mjs";

const ChatWorkspace = lazy(() => import("../features/chat/chat-workspace").then(module => ({default: module.ChatWorkspace})));
const ContactOriginWorkspace = lazy(() => import("../features/projects/contacts/origin").then(module => ({default: module.ContactOriginWorkspace})));
const ReceivedPackageReader = lazy(() => import("../features/trust-packages/received-package-reader").then(module => ({default: module.ReceivedPackageReader})));
const OnlineAccountSettings = lazy(() => import("../features/accounts/online-account-settings").then(module => ({default: module.OnlineAccountSettings})));
const PublicAccountWorkspace = lazy(() => import("../features/accounts/public-account-workspace").then(module => ({default: module.PublicAccountWorkspace})));
const AccountFollowsWorkspace = lazy(() => import("../features/account-follows/workspace").then(module => ({default: module.AccountFollowsWorkspace})));
const DiscoveryWorkspace = lazy(() => import("../features/projects/discovery").then(module => ({default: module.DiscoveryWorkspace})));
const ContentSearchWorkspace = lazy(() => import("../features/discovery/content-search").then(module => ({default: module.ContentSearchWorkspace})));
const TaskCollaboration = lazy(() => import("../features/tasks/task-collaboration").then(module => ({default: module.TaskCollaboration})));
const FactReceiptRecovery = lazy(() => import("../features/work-records/workspace").then(module => ({default: module.FactReceiptRecovery})));
const TaskOperationRecovery = lazy(() => import("../features/tasks/operations/task-operation-recovery").then(module => ({default: module.TaskOperationRecovery})));
const TaskOwnerReadWorkspace = lazy(() => import("../features/tasks/owner/task-owner-read-workspace").then(module => ({default: module.TaskOwnerReadWorkspace})));
const NotificationWorkspace = lazy(() => import("../features/notifications/workspace").then(module => ({default: module.NotificationWorkspace})));
const ProjectContactWorkspace = lazy(() => import("../features/projects/management/workspace").then(module => ({default: module.ProjectContactWorkspace})));
const ProjectDetailWorkspace = lazy(() => import("../features/projects/detail").then(module => ({default: module.ProjectDetailWorkspace})));
const ConfigurationWorkspace = lazy(() => import("../features/tools/configuration-workspace").then(module => ({default: module.ConfigurationWorkspace})));
const BuildersWorkspace = lazy(() => import("../features/builders/builders-workspace").then(module => ({default: module.BuildersWorkspace})));
const ContributionWorkspace = lazy(() => import("../features/work-records/contribution-workspace").then(module => ({default: module.ContributionWorkspace})));
const AgentIdentityWorkspace = lazy(() => import("../features/agent-identity/agent-identity-workspace").then(module => ({default: module.AgentIdentityWorkspace})));

import {type TaskPageTask} from "../features/tasks/task-page-view";
import {taskViewTitle,TaskMaterialNotice} from "../features/tasks/materials/task-material-view";
import {TaskRequestReading} from "../features/tasks/task-request-reading";
import {AgentWorkContinuation} from "../features/local-galaxy/agent-work-continuation";

import {MemberLink,useMemberNames} from "../shared/people/conversation-ui";
const PrivacyWorkspace = lazy(() => import("../features/privacy/privacy-workspace").then(module => ({default: module.PrivacyWorkspace})));
const HelpSearchWorkspace = lazy(() => import("../features/help-search/help-search-workspace").then(module => ({default: module.HelpSearchWorkspace})));
const TaskCommentsWorkspace = lazy(() => import("../features/tasks/comments/task-comments-workspace").then(module => ({default: module.TaskCommentsWorkspace})));
const CapsuleWorkspace = lazy(() => import("../features/capsules/capsule-workspace").then(module => ({default: module.CapsuleWorkspace})));
const TaskDirectoryWorkspace = lazy(() => import("../features/tasks/task-directory-workspace").then(module => ({default: module.TaskDirectoryWorkspace})));
const TaskPublishWorkspace = lazy(() => import("../features/tasks/publish/task-publish-workspace").then(module => ({default: module.TaskPublishWorkspace})));

const TaskOriginReturn = lazy(() => import("../features/tasks/publish/task-origin-workspace").then(module => ({default: module.TaskOriginReturn})));
const TaskApplication = lazy(() => import("../features/tasks/task-application").then(module => ({default: module.TaskApplication})));
const QualificationPermissionWorkspace = lazy(() => import("../features/qualification-permissions/qualification-permission-workspace").then(module => ({default: module.QualificationPermissionWorkspace})));
const HubsWorkspace = lazy(() => import("../features/hubs/hubs-workspace").then(module => ({default: module.HubsWorkspace})));
const WorkerPackUseWorkspace = lazy(() => import("../features/tools/worker-pack-use-workspace").then(module => ({default: module.WorkerPackUseWorkspace})));
const InformationWorkspace = lazy(() => import("../information-workspace").then(module => ({default: module.InformationWorkspace})));
const TargetGovernanceWorkspace = lazy(() => import("../features/governance/target-governance-workspace").then(module => ({default: module.TargetGovernanceWorkspace})));
const ModerationReviewWorkspace = lazy(() => import("../features/governance/moderation-review-workspace").then(module => ({default: module.ModerationReviewWorkspace})));

import {StartPage,PageLoading} from "../site-shell";

const AccountOverview = lazy(() => import("../features/accounts/account-center").then(module => ({default: module.AccountOverview})));
const FeedbackForm = lazy(() => import("../features/feedback/form").then(module => ({default: module.FeedbackForm})));
const AccountAccessWorkspace = lazy(() => import("../features/accounts/account-access").then(module => ({default: module.AccountAccessWorkspace})));
const PersonProfile = lazy(() => import("../features/profiles/person-profile").then(module => ({default: module.PersonProfile})));

const WorkOverview = lazy(() => import("../features/accounts/account-center").then(module => ({default: module.WorkOverview})));
import {ProjectDirectoryWorkspace} from "../features/projects/directory";
import {browseReturnPath,browseReturnLabel} from "../features/discovery/return-navigation";
import {TaskTerms} from "../features/tasks/task-budget-fields";
const CommunityForumWorkspace = lazy(() => import("../features/community-forum/community-forum-workspace").then(module => ({default: module.CommunityForumWorkspace})));
const ReadingBookmarksWorkspace = lazy(() => import("../features/bookmarks/workspace").then(module => ({default: module.ReadingBookmarksWorkspace})));
const CommunityTaskReturn = lazy(() => import("../features/community-forum/community-forum-workspace").then(module => ({default: module.CommunityTaskReturn})));

import {useGalaxySession} from "./galaxy-session";
type Runtime = Awaited<ReturnType<typeof createWebRuntime>>;

type Task = TaskPageTask;
function TaskAuthor({runtime,subjectId,connected,task,navigate}:{runtime:Runtime;subjectId?:string;connected:boolean;task:Task;navigate:(path:string)=>void}){
  const names=useMemberNames(runtime,subjectId,connected,[task.requesterId]);
  return <div className="task-author"><MemberLink subjectId={task.requesterId} name={names[task.requesterId]??undefined} ownId={subjectId} navigate={navigate} avatar/><span>发起的求助</span></div>;
}
const stateNames: Record<string, string> = { open: '正在征集', closed: '已结束', canceled: '已取消', pending: '等待回应', interested: '愿意了解', declined: '已婉拒', expired: '已过期', revoked: '已撤销', question: '有问题待回应' };
export type GalaxyPage="start"|"community"|"bookmarks"|"feedback"|"account"|"public-account"|"work"|"trust-package"|"identity"|"task"|"match"|"find"|"search"|"qualification-permissions"|"capsules"|"privacy"|"participate"|"publish"|"rooms"|"notifications"|"projects"|"project"|"configurations"|"builders"|"worker-packs"|"hubs"|"information"|"reviews"|"governance"|"history"|"person";
export function GalaxyRouteContent({page}:{page:GalaxyPage}){
const {path,routeSearch,runtime,status,setStatus,endpoint,accountRuntime,agentIdentityEntry,error,busy,navigate,task,taskLoading,taskSection,recoverTaskRecords,setRecoverTaskRecords,connected,capsuleRoute,projectRoute,personSubject,qualificationPermissionRoute,packUseRoute,informationRoute,reviewRoute,governanceRoute,forumPostRoute,forumSectionRoute,forumReplyRoute,forumReportRoute,publicAccountRoute,forumPage,projectParameters,accessSection,accountReturn,nativeIdentity,nativeControls,readingTaskResult,governanceTarget,taskDetails,needIdentity,run,registerTaskShellNavigation,registerChatShellNavigation,registerForumShellNavigation}=useGalaxySession();
const pages:Record<GalaxyPage,()=>React.ReactNode>={
"start":()=> <>
        {(path === '/app/' || path === '/app') && <StartPage runtime={runtime} navigate={navigate}/>}

</>,
"community":()=> <>
        {forumPage && runtime && <CommunityForumWorkspace key={`forum:${path}:${routeSearch}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} postId={forumPostRoute?.[1]} versionId={forumPostRoute?.[2]} replyId={forumReplyRoute?.[1]} reportId={forumReportRoute?.[1]} memberSectionId={forumSectionRoute?.[1]} section={projectParameters.get('section') ?? 'all'} compose={projectParameters.get('compose') === 'post'} manage={projectParameters.get('manage') === '1'} routeSearch={routeSearch} browseReturn={browseReturnPath('/app/community')} browseReturnLabel={browseReturnLabel('/app/community')} registerShellNavigation={registerForumShellNavigation}/>}

</>,
"bookmarks":()=> <>
        {path==='/app/bookmarks'&&<ReadingBookmarksWorkspace runtime={accountRuntime} connected={false} navigate={navigate} search={routeSearch}/>}

</>,
"feedback":()=> <>
        {path==='/app/feedback'&&<FeedbackForm endpoint={endpoint} navigate={navigate}/>}

</>,
"account":()=> <>
        {path==='/app/account'&&!['access','settings','following'].includes(projectParameters.get('section')??'')&&<AccountOverview endpoint={endpoint} navigate={navigate}/>}
        {path==='/app/account'&&projectParameters.get('section')==='access'&&<AccountAccessWorkspace endpoint={endpoint} navigate={navigate} section={accessSection} returnTo={accountReturn} identityControls={nativeControls}/>}
        {path==='/app/account'&&projectParameters.get('section')==='settings'&&<OnlineAccountSettings endpoint={endpoint} navigate={navigate} view={projectParameters.get('view')??'profile'}/>}
        {path==='/app/account'&&projectParameters.get('section')==='following'&&<AccountFollowsWorkspace endpoint={endpoint} navigate={navigate} search={routeSearch}/>}

</>,
"public-account":()=> <>
        {publicAccountRoute&&<PublicAccountWorkspace key={publicAccountRoute[1]} accountId={publicAccountRoute[1]} endpoint={endpoint} navigate={navigate} onReturn={target=>navigate(target,{profileReturn:true})}/>}

</>,
"work":()=> <>
        {path==='/app/work'&&<WorkOverview endpoint={endpoint} navigate={navigate}/>}

</>,
"trust-package":()=> <>
        {path==='/app/settings/trust-package'&&<ReceivedPackageReader runtime={runtime} subjectId={nativeIdentity?.subjectId} connected={!!nativeIdentity&&connected} navigate={navigate} returnTo={accountReturn}/>}

</>,
"identity":()=> <>
        {path==='/app/settings/identity'&&agentIdentityEntry&&<AgentIdentityWorkspace key={path+routeSearch} runtime={runtime} entry={agentIdentityEntry} identity={status?.identity??null} connection={status?.connection??null} navigate={navigate} onChange={async()=>{if(runtime)setStatus(await runtime.status());}} onManual={()=>navigate('/app/account?section=access')}/>}

</>,
"task":()=> <>{runtime&&<>
        {taskLoading&&!task&&/^\/app\/tasks\/[0-9a-f-]{36}$/.test(path)&&<PageLoading label="正在读取这项求助…"/>}
        {!taskLoading&&!task&&runtime&&/^\/app\/tasks\/[0-9a-f-]{36}$/.test(path)&&<section className={connected&&recoverTaskRecords?'task-records-return':'object-unavailable'}>
          {connected&&recoverTaskRecords?<><button className="back-link" onClick={()=>setRecoverTaskRecords(false)}> 返回原请求入口</button>
            <TaskOwnerReadWorkspace key={`${path}:${status?.identity?.subjectId??'visitor'}:${status?.connection?.bindingId??''}:${status?.connection?.generation??''}`} runtime={runtime} taskId={path.split('/').at(-1)!} connected={connected}/>
            <ReadingDetails className="technical-details"><ReadingSummary>原请求的完整页面暂不可读</ReadingSummary><p>{error||'当前未取得完整页面，可以重新读取或返回任务目录。'}</p><div className="button-row"><Button variant="outline" disabled={busy} onClick={()=>run(()=>taskDetails(path.split('/').at(-1)!))}>重新读取完整页面</Button><button className="text-link" onClick={()=>navigate('/app/participate')}>返回任务目录</button></div></ReadingDetails>
          </>:<><h1 className="small">暂时无法打开这项求助</h1><p>{connected?'可以重试，或返回任务目录。':'如果这项求助分享给了你，请接续获准的银河身份。'}</p><div className="button-row"><Button disabled={busy} onClick={()=>run(()=>taskDetails(path.split('/').at(-1)!))}>重新读取</Button>{!connected&&<Button variant="outline" onClick={needIdentity}>接续已有身份</Button>}<button className="text-link" onClick={()=>navigate('/app/participate')}>返回任务目录</button></div>{error&&<ReadingDetails className="technical-details"><ReadingSummary>读取问题详情</ReadingSummary><p>{error}</p></ReadingDetails>}{connected&&<button className="text-link" onClick={()=>setRecoverTaskRecords(true)}>查看我在这里留下的记录</button>}</>}
          <FactReceiptRecovery key={`fact-receipt:${path}:${status?.identity?.subjectId??'visitor'}:${status?.connection?.bindingId??''}:${status?.connection?.generation??''}`} runtime={runtime} subjectId={status?.identity?.subjectId} taskId={path.split('/').at(-1)!} connected={connected}/>
        </section>}
        {task && <section className={'task-page'+(readingTaskResult?' task-result-page':'')}>{readingTaskResult?<a className="result-task-context" href={'/app/tasks/'+task.taskId} onClick={event=>{event.preventDefault();navigate('/app/tasks/'+task.taskId);}}>来自求助：{taskViewTitle(task)}</a>:<><a className="back-link" href={browseReturnPath('/app/participate')} onClick={e=>{e.preventDefault();navigate(browseReturnPath('/app/participate'));}}>{browseReturnLabel('/app/participate')}</a><span className="tag">{stateNames[task.state] ?? task.state}</span><h1 className="small">{taskViewTitle(task)}</h1></>}{taskSection==='overview'&&<TaskAuthor runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} task={task} navigate={navigate}/>}
          {task.schemaVersion===2&&!readingTaskResult&&<nav className="task-tabs" aria-label="当前求助">{[['overview','详情'],['collaboration','协作'],['comments','讨论']].map(([id,title])=><button key={id} aria-current={taskSection===id?'page':undefined} onClick={()=>navigate(`/app/tasks/${task.taskId}?section=${id}`)}>{title}</button>)}</nav>}
          {taskSection==='overview'&&<section className="request-detail-body" aria-label="求助详情"><TaskMaterialNotice task={task}/><TaskRequestReading task={task} runtime={runtime} connected={connected} subjectId={status?.identity?.subjectId} navigate={navigate}/><footer className="task-read-actions"><TaskTerms request={task.request}/>{task.view!=='requester'&&task.schemaVersion===2&&<Button onClick={()=>navigate(`/app/tasks/${task.taskId}?section=apply`)}>{task.state==='open'?'我可以提供帮助':'查看参与情况'}</Button>}</footer></section>}
          {taskSection==='apply'&&<section className="task-apply"><button className="back-link" onClick={()=>navigate(`/app/tasks/${task.taskId}`)}>返回任务详情</button><TaskApplication key={`${task.taskId}:${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}`} task={task} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} refresh={() => taskDetails(task.taskId)} onNeedIdentity={needIdentity}/></section>}
          {taskSection==='collaboration'&&task.schemaVersion===2&&<div role="tabpanel" aria-label="参与与交付"><TaskCollaboration key={`${task.taskId}:${status?.identity?.subjectId??'visitor'}:${status?.connection?.bindingId??''}`} task={task} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} refresh={() => taskDetails(task.taskId)}/></div>}
          {taskSection==='comments'&&<div role="tabpanel" aria-label="讨论"><TaskCommentsWorkspace key={`comments:${task.taskId}:${status?.endpoint}:${status?.identity?.subjectId ?? "anonymous"}:${status?.identity?.deviceId??""}:${status?.connection?.bindingId??""}:${status?.connection?.generation??""}`} task={task} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate}/></div>}
          <TaskOperationRecovery key={`recovery:${task.taskId}:${status?.identity?.subjectId ?? "visitor"}:${status?.connection?.bindingId ?? ""}`} runtime={runtime} connected={connected} taskId={task.taskId} managedFeedback={taskSection==='collaboration'&&(!projectParameters.get('view')||projectParameters.get('view')==='people')&&(task.participations??[]).some(participant=>requesterFeedbackAvailable(task,participant,status?.identity?.subjectId))} onComplete={() => taskDetails(task.taskId)}/>
          {task.schemaVersion===2&&<TaskOriginReturn runtime={runtime} connected={connected} subjectId={status?.identity?.subjectId} task={task} navigate={navigate}/>}
          {task.schemaVersion===2&&<CommunityTaskReturn key={`forum-return:${task.taskId}:${status?.endpoint}:${status?.identity?.subjectId ?? 'visitor'}:${status?.identity?.deviceId ?? ''}:${status?.connection?.bindingId ?? ''}:${status?.connection?.generation ?? ''}`} runtime={runtime} connected={connected} subjectId={status?.identity?.subjectId} task={task} navigate={navigate}/>}
          <AgentWorkContinuation runtime={runtime} subjectId={status?.identity?.subjectId} object={{kind:'task',id:task.taskId}} title={taskViewTitle(task)} purpose="接着这项求助，理解当前问题、已取得的结果与还缺少的材料" onNeedIdentity={needIdentity}/></section>}
        {/^\/app\/tasks\/[0-9a-f-]{36}$/.test(path) && task && <Button variant="outline" disabled={!connected} onClick={() => navigate('/app/governance?targetType=task&targetId=' + task.taskId)}>举报与处理</Button>}
</>}
</>,
"match":()=> <>{runtime&&<>
        {path === '/app/match' && <DiscoveryWorkspace key={routeSearch} runtime={runtime} connected={connected} navigate={navigate}/>}
</>}
</>,
"find":()=> <>{runtime&&<>
        {path === '/app/find' && <ContentSearchWorkspace key={routeSearch} runtime={runtime} navigate={navigate} search={routeSearch}/>}
</>}
</>,
"search":()=> <>{runtime&&<>
        {path === '/app/search' && <HelpSearchWorkspace key={routeSearch} runtime={runtime} connected={connected} subjectId={status?.identity?.subjectId} navigate={navigate}/>}
</>}
</>,
"qualification-permissions":()=> <>{runtime&&<>
        {qualificationPermissionRoute && <QualificationPermissionWorkspace key={`${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}:${qualificationPermissionRoute[1] ?? ''}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} initialRequestId={qualificationPermissionRoute[1]} onNeedIdentity={needIdentity}/>}
</>}
</>,
"capsules":()=> <>{runtime&&<>
        {capsuleRoute && <CapsuleWorkspace key={`${status?.endpoint ?? ''}:${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? 'disconnected'}:${status?.connection?.generation ?? ''}:${path}:${routeSearch}`} runtime={runtime} connected={connected} subjectId={status?.identity?.subjectId} navigate={navigate} capsuleId={capsuleRoute[1]} versionId={capsuleRoute[2]}/>}
</>}
</>,
"privacy":()=> <>{runtime&&<>
        {path === '/app/settings/privacy' && <PrivacyWorkspace key={`${status?.endpoint??''}:${status?.identity?.subjectId??'visitor'}:${status?.connection?.bindingId??'disconnected'}:${status?.connection?.generation??''}`} runtime={runtime} connected={connected} subjectId={status?.identity?.subjectId} navigate={navigate}/>}
</>}
</>,
"participate":()=> <>{runtime&&<>
        {path === '/app/participate' && <TaskDirectoryWorkspace search={routeSearch} key={`task-directory:${status?.identity?.subjectId ?? 'anonymous'}:${status?.connection?.bindingId ?? ''}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} needIdentity={needIdentity}/> }
</>}
</>,
"publish":()=> <>{runtime&&<>
        {path === '/app/publish' && <TaskPublishWorkspace key={`${routeSearch}:${status?.endpoint}:${status?.identity?.subjectId ?? 'visitor'}:${status?.identity?.deviceId ?? ''}:${status?.connection?.bindingId ?? ''}:${status?.connection?.generation ?? ''}:${status?.localDraftGeneration ?? ''}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} onNeedIdentity={needIdentity} registerShellNavigation={registerTaskShellNavigation}/>}
</>}
</>,
"rooms":()=> <>{runtime&&<>
        {/\/app\/rooms(?:\/[0-9a-f-]{36})?$/.test(path) && <ChatWorkspace key={path} runtime={runtime} roomId={/^\/app\/rooms\/([0-9a-f-]{36})$/.exec(path)?.[1]} search={routeSearch} connected={connected} subjectId={status?.identity?.subjectId} navigate={navigate} needIdentity={needIdentity} registerShellNavigation={registerChatShellNavigation}/> }
</>}
</>,
"notifications":()=> <>{runtime&&<>
        {path === '/app/notifications' && <NotificationWorkspace runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate}/>}
</>}
</>,
"projects":()=> <>{runtime&&<>
        {path === '/app/projects' && !['projects','contacts','recruitment','willingness','discover'].includes(projectParameters.get('section')??'') && <ProjectDirectoryWorkspace runtime={runtime} navigate={navigate}/>}
        {path === '/app/projects' && ['projects','contacts','recruitment','willingness','discover'].includes(projectParameters.get('section')??'') && <ProjectContactWorkspace runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} initialTab={projectParameters.get('section') ?? undefined} initialProjectId={projectParameters.get('projectId') ?? undefined} initialContactId={projectParameters.get('contactId') ?? undefined}/>}
</>}
</>,
"project":()=> <>{runtime&&<>
        {projectRoute && <><ContactOriginWorkspace runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} projectId={projectRoute[1]} contactId={projectParameters.get('fromContact')??undefined} roomId={projectParameters.get('fromRoom')??undefined}/><ProjectDetailWorkspace runtime={runtime} subjectId={status?.identity?.subjectId ?? null} connected={connected} navigate={navigate} projectId={projectRoute[1]}/></>}
</>}
</>,
"configurations":()=> <>{runtime&&<>
        {path === '/app/configurations' && <ConfigurationWorkspace key={`${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate}/>}
</>}
</>,
"builders":()=> <>{runtime&&<>
        {path === '/app/builders' && <BuildersWorkspace key={`${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate}/>}
</>}
</>,
"worker-packs":()=> <>{runtime&&<>
        {(path === '/app/worker-packs' || packUseRoute) && <WorkerPackUseWorkspace key={`${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}:${path}:${routeSearch}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} onNeedIdentity={needIdentity} useId={packUseRoute?.[1]} builderId={projectParameters.get('builderId') ?? undefined} manifestId={projectParameters.get('manifestId') ?? undefined}/>}
</>}
</>,
"hubs":()=> <>{runtime&&<>
        {path === '/app/hubs' && <HubsWorkspace key={`${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected}/>}
</>}
</>,
"information":()=> <>{runtime&&<>
        {informationRoute && <InformationWorkspace key={`${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}:${path}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} onNeedIdentity={needIdentity} watchId={informationRoute[1]}/>}
</>}
</>,
"reviews":()=> <>{runtime&&<>
        {reviewRoute && <ModerationReviewWorkspace key={path+routeSearch+(status?.identity?.subjectId??'')} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} reportId={reviewRoute[1]} caseId={projectParameters.get('caseId')??undefined} navigate={navigate}/>}
</>}
</>,
"governance":()=> <>{runtime&&<>
        {governanceRoute && <TargetGovernanceWorkspace key={`${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}:${path}:${routeSearch}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} reportId={governanceRoute[1]} target={governanceTarget}/>}
</>}
</>,
"history":()=> <>{runtime&&<>
        {path === '/app/history' && <ContributionWorkspace runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate}/>}
</>}
</>,
"person":()=> <>{runtime&&<>
        {personSubject && <PersonProfile runtime={runtime} subjectId={status?.identity?.subjectId} targetSubjectId={personSubject} connected={connected} search={routeSearch} navigate={navigate} onReturn={target=>navigate(target,{profileReturn:true})}/>}

</>}
</>,
};return <Suspense fallback={<PageLoading label="正在打开页面…"/>}>{pages[page]()}</Suspense>;
}
