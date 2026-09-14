import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowRight, Compass, Plus, Handshake, MessagesSquare, Fingerprint, ArrowLeft, RefreshCw, Copy, Download, Orbit, Bell, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { createWebRuntime, loadWebConfiguration } from './runtime.mjs';
import { ChatWorkspace } from './chat-workspace';
import { AccountSettings } from './account-settings';
import { DiscoveryWorkspace } from './discovery-workspace';
import { TaskCollaboration } from './task-collaboration';
import { TaskOperationRecovery } from './task-operation-recovery';
import { PersonalSummaryWorkspace } from './personal-summary-workspace';
import { NotificationWorkspace } from './notification-workspace';
import { ProjectContactWorkspace } from './project-contact-workspace';
import { ProjectDetailWorkspace } from './project-detail-workspace';
import { ConfigurationWorkspace } from './configuration-workspace';
import { BuildersWorkspace } from './builders-workspace';
import { ContributionWorkspace } from './contribution-workspace';
import { IdentityWorkspace } from './identity-workspace';
import { IdentityGroupWorkspace } from './identity-group-workspace';
import { PrivacyWorkspace } from './privacy-workspace';
import { HelpSearchWorkspace } from './help-search-workspace';
import { TaskCommentsWorkspace } from './task-comments-workspace';
import { CapsuleWorkspace } from './capsule-workspace';
import { TaskDirectoryWorkspace } from './task-directory-workspace';
import { TaskPublishWorkspace } from './task-publish-workspace';
import { TaskApplication } from './task-application';
import { QualificationPermissionWorkspace } from './qualification-permission-workspace';
import { TrustPackageWorkspace } from './trust-package-workspace';
import { HubsWorkspace } from './hubs-workspace';
import { WorkerPackUseWorkspace } from './worker-pack-use-workspace';
import { InformationWorkspace } from './information-workspace';
import { TargetGovernanceWorkspace } from './target-governance-workspace';
import { closeSummaryRuntime } from './summary-runtime.mjs';
import '@/app/globals.css';
import './workspace.css';

type Runtime = Awaited<ReturnType<typeof createWebRuntime>>;
type Task = { taskId: string; schemaVersion: number; version: number; state: string; view: string; requesterId: string; caseId: string | null;
  request: { title: string; summary: string; workContext: { goal: string; currentSituation: string }; visibility: string; collaboration: string };
  contacts?: { suggestions: { state: string; items: { subjectId: string; help: string; basis: string }[] }; responses: { applications: { applicationId: string; subjectId: string; proposal: string; scope: string }[]; invitations: { invitationId: string; recipientId: string; note: string; state: string }[] } } };
const entries = [{ path: '/app/match', label: '发现匹配', icon: Compass }, { path: '/app/publish', label: '发布任务', icon: Plus },
  { path: '/app/participate', label: '参与任务', icon: Handshake }, { path: '/app/rooms', label: '聊天', icon: MessagesSquare },
  { path: '/app/projects', label: '项目与联系', icon: Compass },
  { path: '/app/history', label: '履历与贡献', icon: Compass },
  { path: '/app/capsules', label: 'Capsule 方法', icon: FileText },
  { path: '/app/configurations', label: '配置版本', icon: FileText },
  { path: '/app/qualification-permissions', label: '材料许可', icon: FileText },
  { path: '/app/builders', label: '建设者与接入', icon: FileText },
  { path: '/app/worker-packs', label: 'Worker Pack 使用', icon: FileText },
  { path: '/app/hubs', label: 'Hub 社区与互联', icon: Compass },
  { path: '/app/information', label: '信息与关注', icon: Compass },
  { path: '/app/governance', label: '举报与处理', icon: FileText },
  { path: '/app/search', label: '检索帮助', icon: Compass },
  { path: '/app/settings/privacy', label: '隐私与数据', icon: FileText },
  { path: '/app/settings/trust-package', label: '身份与资料包', icon: FileText },
  { path: '/app/notifications', label: '通知', icon: Bell }, { path: '/app/settings/summaries', label: '个人摘要', icon: FileText },
  { path: '/app/settings/identity', label: '身份与设置', icon: Fingerprint }];
const stateNames: Record<string, string> = { open: '正在征集', closed: '已结束', canceled: '已取消', pending: '等待回应', interested: '愿意了解', declined: '已婉拒', expired: '已过期', revoked: '已撤销', question: '有问题待回应' };
function readable(error: unknown) {
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) return '请求等待超时或已取消，请检查当前网络后重试。';
  const message = error instanceof Error ? error.message : '操作未完成，请重试。';
  return ({ connection_required: '请先连接当前银河身份，再继续这一步。', account_verification_required: '发布或加入房间前需要验证账号，请前往身份与设置完成验证。', community_quota_exceeded: '今天的公开操作额度已用完，请稍后再试。', verified_account_required: '此操作需要验证账号。', not_found: '内容不存在，或当前身份没有查看权限。', public_write_quota_exceeded: '今天的操作额度已用完，请稍后再试。', request_timeout: '请求等待超时，请检查当前网络后重试。' } as Record<string, string>)[message] ?? message;
}
function App() {
  const [path, setPath] = useState(location.pathname), [runtime, setRuntime] = useState<Runtime | null>(null), [status, setStatus] = useState<any>(null);
  const [routeSearch, setRouteSearch] = useState(location.search);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [configError, setConfigError] = useState('');
  const [task, setTask] = useState<Task | null>(null), [query, setQuery] = useState('');
  const taskRequest = useRef(0);
  const [results, setResults] = useState<any[]>([]), [sourceType, setSourceType] = useState('history');
  const [recoveryCode, setRecoveryCode] = useState(''), [newCode, setNewCode] = useState(''), [recovered, setRecovered] = useState(false), [returnPath, setReturnPath] = useState('/app/');
  const navigate = (target: string) => { history.pushState(null, '', target); setPath(location.pathname); setRouteSearch(location.search); setError(''); setNotice(''); window.scrollTo(0, 0); };
  useEffect(() => { const changed = () => { setPath(location.pathname); setRouteSearch(location.search); }; addEventListener('popstate', changed); return () => removeEventListener('popstate', changed); }, []);
  useEffect(() => { let active = true, opened: Runtime | null = null;
    const initialization = loadWebConfiguration().then(config => createWebRuntime(config));
    const timeout = new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('网站初始化超时，请检查当前网络后重试。')), 12000));
    Promise.race([initialization, timeout]).then(async value => { opened = value; if (!active) return value.close(); setRuntime(value); setStatus(await value.status()); })
      .catch(reason => { if (active) setConfigError(readable(reason)); });
    return () => { active = false; if(opened)closeSummaryRuntime(opened); opened?.close(); };
  }, []);
  useEffect(() => {
    if (!runtime) return;
    let active = true;
    const refresh = () => {
      if (active && !document.hidden) runtime.status().then(next => { if (active) setStatus(next); }).catch(() => {});
    };
    document.addEventListener('visibilitychange', refresh);
    return () => { active = false; document.removeEventListener('visibilitychange', refresh); };
  }, [runtime]);
  async function run(action: () => Promise<void>) { if (busy) return; setBusy(true); setError(''); setNotice(''); try { await action(); } catch (reason) { setError(readable(reason)); } finally { if (runtime) setStatus(await runtime.status()); setBusy(false); } }
  useEffect(() => { if (!runtime) return; const timer = setInterval(() => runtime.status().then(setStatus), 15000); return () => clearInterval(timer); }, [runtime]);
  async function taskDetails(id: string) { const request=++taskRequest.current; const current=runtime; if (!current) return; const result = await current.api.call(`/v2/tasks/${id}`, null, { method: 'GET', authenticated: !!current.api.snapshot() }); if (request===taskRequest.current && current===runtime && location.pathname === `/app/tasks/${id}`) setTask(result); }
  useEffect(() => { setTask(null); setResults([]); if (!runtime) return;
    const id = /^\/app\/tasks\/([0-9a-f-]{36})$/.exec(path)?.[1];
    if (id) {
      taskDetails(id).catch(reason => setError(readable(reason)));
      const refreshOnVisible = () => { if (!document.hidden) taskDetails(id).catch(reason => setError(readable(reason))); };
      document.addEventListener('visibilitychange', refreshOnVisible);
      return () => { taskRequest.current++; document.removeEventListener('visibilitychange', refreshOnVisible); };
    }
    if (path.startsWith('/app/settings/')) runtime.pendingRecoveryCode().then(value => { if (value) { setNewCode(value.code); setRecovered(value.recovered); } }).catch(reason => setError(readable(reason)));
    return () => { taskRequest.current++; };
  }, [path, runtime, status?.connection?.bindingId]);
  function needIdentity() { setReturnPath(path + location.search); navigate('/app/settings/identity'); }
  const connected = !!status?.connection;
  async function search() {
    if (!runtime) return; const result = await runtime.api.call('/v1/search/query', { type: sourceType, query: { query, limit: 8 } }, { authenticated: connected }); setResults(result.items);
    setNotice(result.windowLimited ? '本次返回有限范围，可缩小条件继续查找。' : result.items.length ? '以下依据来自当前可见资料，请结合任务环境判断。' : '暂时没有匹配资料。可以调整描述，或发布任务寻找愿意参与的人。');
  }
  async function copyCode() { await navigator.clipboard.writeText(newCode); setNotice('已复制，请保存在这台设备之外。保存完成后点击“我已保存”。'); }
  function downloadCode() { const url = URL.createObjectURL(new Blob([newCode + '\n'], { type: 'text/plain;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = 'galaxy-recovery.txt'; link.click(); URL.revokeObjectURL(url); }
  const link = (target: string, text: string) => <a href={target} onClick={event => { event.preventDefault(); navigate(target); }}>{text}</a>;
  const capsuleRoute = /^\/app\/capsules(?:\/([0-9a-f-]{36})(?:\/versions\/([0-9a-f-]{36}))?)?$/.exec(path);
  const projectRoute = /^\/app\/projects\/([0-9a-f-]{36})$/.exec(path);
  const qualificationPermissionRoute = /^\/app\/qualification-permissions(?:\/([0-9a-f-]{36}))?$/.exec(path);
  const packUseRoute = /^\/app\/worker-pack-uses\/([0-9a-f-]{36})$/.exec(path);
  const informationRoute = /^\/app\/information(?:\/([0-9a-f-]{36}))?$/.exec(path);
  const governanceRoute = /^\/app\/governance(?:\/([0-9a-f-]{36}))?$/.exec(path);
  const projectParameters = new URLSearchParams(routeSearch);
  const governanceTargetType = projectParameters.get('targetType'), governanceTargetId = projectParameters.get('targetId');
  const governanceTarget = (governanceTargetType === 'task' || governanceTargetType === 'room') && /^[0-9a-f-]{36}$/.test(governanceTargetId ?? '')
    ? { type: governanceTargetType as 'task' | 'room', id: governanceTargetId! } : undefined;
  const knownPath = path === '/app' || path === '/app/' || entries.some(entry => entry.path === path)
    || /^\/app\/(?:tasks|rooms)\/[0-9a-f-]{36}$/.test(path) || !!capsuleRoute || !!projectRoute || !!qualificationPermissionRoute || !!packUseRoute || !!informationRoute || !!governanceRoute;
  return <div className="galaxy-workspace">
    <header className="workspace-header"><a className="galaxy-brand" href="/" aria-label="银河官网"><Orbit size={27}/><strong>银河<span>GALAXY</span></strong></a><div className="workspace-status"><span className={connected ? 'dot connected' : 'dot'}/>{connected ? '身份已连接' : '尚未连接'}<Button variant="ghost" size="sm" onClick={needIdentity}>我的身份</Button></div></header>
    <div className="workspace-layout"><aside className="workspace-sidebar"><button className="workspace-home" onClick={() => navigate('/app/')}>工作区 <ArrowRight size={15}/></button><nav aria-label="银河功能">{entries.map(({ path: target, label, icon: Icon }) => <a key={target} href={target} aria-current={path === target ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate(target); }}><Icon size={19}/>{label}</a>)}</nav><div className="sidebar-foot">你的工作，更多同行者。<a href="/docs/">使用文档 ↗</a><a href="/privacy/">隐私与数据 ↗</a></div></aside>
      <main className="workspace-main" aria-busy={busy}>
        {configError && <div className="message error" role="alert">{configError}<p>你可以继续浏览官网介绍和使用文档。此页面不会用演示数据替代业务结果。</p></div>}
        {error && <div className="message error" role="alert">{error}</div>}{notice && <div className="message" role="status">{notice}</div>}
        {!knownPath && <section><h1 className="small">找不到这个页面</h1><p>链接没有对应的银河页面。可以回到工作区选择入口，或让原聊天中的模型核对对象地址。</p><Button onClick={() => navigate('/app/')}>回到工作区</Button></section>}
        {path === '/app/' || path === '/app' ? <><div className="eyebrow">连接帮助，继续向前</div><h1>让你的下一步，<br/><span>有人一起想。</span></h1><p className="lead">找到相关经历、可复用的方法，以及愿意参与的人与 Agent。带着真实的工作上下文，选择适合此刻的帮助。</p><div className="entry-grid">{entries.slice(0, 3).map(({ path: target, label, icon: Icon }, i) => <button className="entry-card" key={target} onClick={() => navigate(target)}><Icon size={26}/><h2>{label}</h2><p>{['看看相关能力、项目和可用的方法。', '说明目标，邀请他人共同推进。', '找到你愿意帮助的真实工作。'][i]}</p><ArrowRight size={20}/></button>)}</div><div className="help-intro"><h2>帮助不只有一种方式</h2><p>继续与当前 AI 探索、采用已有 Capsule 或方案、寻找开放协助，或选择赏金与专家协助。你决定要走哪条路，也可以中途切换。</p><p>日常聊天同样有价值，无需先创建任务。已有插件可以从原聊天打开这里的具体内容，随后返回继续工作。</p></div></> : null}
        {path === '/app/match' && <DiscoveryWorkspace runtime={runtime} connected={connected} navigate={navigate}/>}
        {path === '/app/search' && <HelpSearchWorkspace runtime={runtime} connected={connected} subjectId={status?.identity?.subjectId} navigate={navigate}/>}
        {qualificationPermissionRoute && <QualificationPermissionWorkspace key={`${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}:${qualificationPermissionRoute[1] ?? ''}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} initialRequestId={qualificationPermissionRoute[1]} onNeedIdentity={needIdentity}/>}
        {capsuleRoute && <CapsuleWorkspace key={`${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? 'disconnected'}`} runtime={runtime} connected={connected} subjectId={status?.identity?.subjectId} navigate={navigate} capsuleId={capsuleRoute[1]} versionId={capsuleRoute[2]}/>}
        {path === '/app/settings/privacy' && <PrivacyWorkspace key={status?.identity?.subjectId ?? 'visitor'} runtime={runtime} connected={connected} subjectId={status?.identity?.subjectId} navigate={navigate}/>}
        {path === '/app/settings/trust-package' && <TrustPackageWorkspace key={`${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate}/>}
        {path === '/app/participate' && <TaskDirectoryWorkspace key={`task-directory:${status?.identity?.subjectId ?? 'anonymous'}:${status?.connection?.bindingId ?? ''}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} needIdentity={needIdentity}/> }
        {path === '/app/publish' && <TaskPublishWorkspace key={`${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} onNeedIdentity={needIdentity}/>}
        {task && <><button className="back-link" onClick={() => navigate('/app/participate')}><ArrowLeft size={16}/>参与任务</button><span className="tag">{stateNames[task.state] ?? task.state}</span><h1 className="small">{task.request.title}</h1><p className="lead">{task.request.summary}</p><Card><CardContent className="task-body"><h2>希望完成</h2><p>{task.request.workContext?.goal}</p><h2>当前情况</h2><p>{task.request.workContext?.currentSituation}</p><p className="muted">任务与参与、交付、验证分别记录。打开或阅读此页不会自动加入协作。</p></CardContent></Card>{task.schemaVersion !== 2 && <p className="message">这是历史版本任务，新版操作尚不适用于此对象。</p>}{task.view !== 'requester' && task.schemaVersion === 2 && <TaskApplication key={`${task.taskId}:${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}`} task={task} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} refresh={() => taskDetails(task.taskId)} onNeedIdentity={needIdentity}/>}<div className="button-row"><Button variant="outline" disabled={!connected || busy} onClick={() => run(async () => { const receipt = await runtime!.reconcileTaskEvent(task.taskId); await taskDetails(task.taskId); setNotice(receipt.state === "none" ? "没有待查询的任务操作。" : receipt.state === "acknowledged" ? "原操作已确认，已刷新当前状态。" : "原操作尚未确认，可使用原内容重试。"); })}>查询上次操作</Button><Button variant="ghost" disabled={!connected || busy} onClick={() => run(async () => { await runtime!.reconcileTaskEvent(task.taskId, { retry: true }); await taskDetails(task.taskId); })}>重试原操作</Button></div><TaskOperationRecovery key={`recovery:${task.taskId}`} runtime={runtime} connected={connected} taskId={task.taskId} onComplete={() => taskDetails(task.taskId)}/><TaskCollaboration key={task.taskId} task={task} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} refresh={() => taskDetails(task.taskId)}/><TaskCommentsWorkspace key={`comments:${task.taskId}:${status?.identity?.subjectId ?? "anonymous"}`} task={task} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected}/><p className="return-note">回到原聊天后，让你的模型刷新这项任务的状态并继续工作。关闭网页不会取消任务。</p></>}
        {/^\/app\/tasks\/[0-9a-f-]{36}$/.test(path) && task && <Button variant="outline" disabled={!connected} onClick={() => navigate('/app/governance?targetType=task&targetId=' + task.taskId)}>举报与处理</Button>}
        {/\/app\/rooms(?:\/[0-9a-f-]{36})?$/.test(path) && <ChatWorkspace key={path + (status?.identity?.subjectId ?? '')} runtime={runtime} roomId={/^\/app\/rooms\/([0-9a-f-]{36})$/.exec(path)?.[1]} connected={connected} subjectId={status?.identity?.subjectId} navigate={navigate} needIdentity={needIdentity}/> }
        {path === '/app/notifications' && <NotificationWorkspace runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate}/>}
        {path === '/app/projects' && <ProjectContactWorkspace runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} initialTab={projectParameters.get('section') ?? undefined} initialProjectId={projectParameters.get('projectId') ?? undefined}/>}
        {projectRoute && <ProjectDetailWorkspace runtime={runtime} subjectId={status?.identity?.subjectId ?? null} connected={connected} navigate={navigate} projectId={projectRoute[1]}/>}
        {path === '/app/configurations' && <ConfigurationWorkspace key={`${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate}/>}
        {path === '/app/builders' && <BuildersWorkspace key={`${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate}/>}
        {(path === '/app/worker-packs' || packUseRoute) && <WorkerPackUseWorkspace key={`${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}:${path}:${routeSearch}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} onNeedIdentity={needIdentity} useId={packUseRoute?.[1]} builderId={projectParameters.get('builderId') ?? undefined} manifestId={projectParameters.get('manifestId') ?? undefined}/>}
        {path === '/app/hubs' && <HubsWorkspace key={`${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected}/>}
        {informationRoute && <InformationWorkspace key={`${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}:${path}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} onNeedIdentity={needIdentity} watchId={informationRoute[1]}/>}
        {governanceRoute && <TargetGovernanceWorkspace key={`${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}:${path}:${routeSearch}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} reportId={governanceRoute[1]} target={governanceTarget}/>}
        {path === '/app/history' && <ContributionWorkspace runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate}/>}
        {path === '/app/settings/summaries' && <PersonalSummaryWorkspace runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate}/>}
        {path === '/app/settings/identity' && <><button className="back-link" onClick={() => navigate(returnPath)}><ArrowLeft size={16}/>回到原目标</button><h1 className="small">身份与设置</h1><p className="lead">银河身份由你掌握。设备确认与恢复码帮助你在换设备后继续使用同一个 ID。</p>{runtime && <p className="muted">当前服务：{status?.endpoint}</p>}{status?.identity ? <Card><CardContent className="task-body"><h2>当前银河身份</h2><code className="identity-id">{status.identity.subjectId}</code><p>{connected ? '已连接当前服务。' : '身份材料保存在本机，尚未连接当前服务。'}</p><div className="button-row"><Button disabled={busy || connected} onClick={() => run(async () => { await runtime!.connect({ confirmed: true }); navigate(returnPath); })}>连接并返回</Button><Button variant="outline" onClick={() => run(async () => { runtime!.disconnect(); })} disabled={!connected}>断开本次连接</Button><Button variant="outline" disabled={busy} onClick={() => run(async () => { const prepared = await runtime!.prepareRecovery(); setNewCode(prepared.code); setRecovered(false); })}>准备或更换恢复码</Button></div></CardContent></Card> : <Card><CardContent className="task-body"><h2>第一次使用银河</h2><p>在这个浏览器创建本机身份，并向所示服务登记公开身份材料。私钥不会上传。你也可以在下方恢复已有身份。</p><Button disabled={!runtime || busy} onClick={() => run(async () => { await runtime!.createIdentity({ confirmed: true }); setNotice('身份已建立。可以连接继续原目标，也可先准备恢复码。'); })}>创建我的银河身份 <ArrowRight/></Button></CardContent></Card>}
          {newCode && <Card><CardContent className="task-body"><h2>{recovered ? '保存新的恢复码' : '保存恢复码'}</h2><p>请复制或下载，并保存在这台设备之外。{recovered ? '旧恢复码已经使用，新码用于下一次恢复。' : '点击“我已保存”后登记；未提交时旧码继续有效。'}</p><textarea className="recovery-code" aria-label="新的恢复码" readOnly value={newCode}/><div className="button-row"><Button variant="outline" onClick={() => run(copyCode)}><Copy/>复制</Button><Button variant="outline" onClick={downloadCode}><Download/>下载</Button><Button disabled={busy} onClick={() => run(async () => { if (recovered) await runtime!.confirmRecoveredCode({ confirmed: true }); else await runtime!.saveRecovery({ confirmed: true }); setNewCode(''); setNotice('保存状态已登记。'); })}>我已保存</Button><Button variant="ghost" onClick={() => setNewCode('')}>稍后处理</Button></div></CardContent></Card>}
          <form className="workspace-form" onSubmit={e => { e.preventDefault(); run(async () => { const result = await runtime!.recover(recoveryCode.trim(), { confirmed: true }); setRecoveryCode(''); setNewCode(result.replacementCode); setRecovered(true); setNotice('已恢复同一身份，旧设备控制已撤销。请保存新的恢复码。'); }); }}><h2>使用恢复码连接已有身份</h2><p className="muted">恢复的是身份控制，旧设备上的私有文件和未同步摘要不会因此自动恢复。提交将撤销这个 ID 的旧设备控制。</p><label>恢复码<Textarea autoComplete="off" spellCheck={false} value={recoveryCode} onChange={e => setRecoveryCode(e.target.value)} required placeholder="galaxy-recovery-v1:…"/></label><Button type="submit" variant="outline" disabled={!runtime || busy}>确认恢复同一身份</Button></form><IdentityWorkspace runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} onChange={async () => { if (runtime) setStatus(await runtime.status()); }}/><IdentityGroupWorkspace key={`identity-group:${status?.identity?.subjectId ?? "visitor"}:${status?.connection?.bindingId ?? ""}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} initialOperationId={projectParameters.get("identityGroupOperation") ?? undefined}/><AccountSettings key={status?.identity?.subjectId} runtime={runtime} connected={connected}/><p className="muted">账号验证、云同步、公开分享分别管理。创建身份不会自动上传全部本机资料。</p></>}
      </main></div><footer className="workspace-footer">银河技术团队<span>{link('/app/', '工作区')}<a href="/">官网</a><a href="/docs/">文档</a></span></footer>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
