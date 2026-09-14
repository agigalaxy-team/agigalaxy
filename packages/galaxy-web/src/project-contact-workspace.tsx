import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FactDetails } from './fact-details';
import { getProjectContactClient } from './project-contact-client.mjs';
import { projectViewScope } from './project-view-client.mjs';

const tags = (x: string) => [
  ...new Set(
    x
      .split(/[,，、\n]/)
      .map((v) => v.trim())
      .filter(Boolean),
  ),
];
const purposeNames: any = {
  conversation: '普通交流',
  reuse: '了解复用',
  collaboration: '共同协作',
  recruitment: '了解招募',
};
const blankProject = {
  kind: 'project',
  title: '',
  summary: '',
  functions: '',
  technologies: '',
  sourceUrl: '',
  participantKind: 'unknown',
  discoverable: false,
};
const blankRecruitment = {
  title: '',
  role: '',
  summary: '',
  functions: '',
  technologies: '',
  conditions: '',
  days: 30,
};
const stateNames: any = {
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
type Props = {
  runtime: any;
  subjectId: string | null;
  connected: boolean;
  navigate: (path: string) => void;
  initialTab?: string;
  initialProjectId?: string;
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
}: Props) {
  const client = useMemo(
    () =>
      runtime && subjectId ? getProjectContactClient(runtime, subjectId) : null,
    [runtime, subjectId],
  );
  const [tab, setTab] = useState(['discover','projects','recruitment','contacts'].includes(initialTab)?initialTab:'discover'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const [pending, setPending] = useState<any[]>([]),
    [query, setQuery] = useState({
      title: '',
      functions: '',
      technologies: '',
      purpose: 'conversation',
    }),
    [submitted, setSubmitted] = useState<any>(null);
  const [opportunities, setOpportunities] = useState<any[]>([]),
    [queryNext, setQueryNext] = useState<string | null>(null),
    [searched, setSearched] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [detail, setDetail] = useState<any>(null);
  const [note, setNote] = useState(''),
    [roomTitle, setRoomTitle] = useState('银河交流'),
    [sendResults, setSendResults] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]),
    [projectNext, setProjectNext] = useState<string | null>(null),
    [project, setProject] = useState<any>(null),
    [projectForm, setProjectForm] = useState<any>(blankProject);
  const [visibility, setVisibility] = useState('Private'),
    [viewers, setViewers] = useState(''),
    [roleSubject, setRoleSubject] = useState(''),
    [role, setRole] = useState('editor'),
    [transferTo, setTransferTo] = useState('');
  const [recruits, setRecruits] = useState<any[]>([]),
    [recruitNext, setRecruitNext] = useState<string | null>(null),
    [recruit, setRecruit] = useState<any>(null),
    [recruitProjectId, setRecruitProjectId] = useState(''),
    [recruitForm, setRecruitForm] = useState<any>(blankRecruitment),
    [taskId, setTaskId] = useState('');
  const [contacts, setContacts] = useState<any[]>([]),
    [contactNext, setContactNext] = useState<string | null>(null),
    [direction, setDirection] = useState('both'),
    [responseNotes, setResponseNotes] = useState<Record<string, string>>({});
  const [discoveryPreferences, setDiscoveryPreferences] = useState<any>(null),
    [projectPreferences, setProjectPreferences] = useState<any>(null);
  const working=useRef(false);
  const writable = !!(connected && subjectId && client);
  useEffect(() => {
    let active=true, reading=false;
    setPending([]);
    setProjects([]);
    setProject(null);
    setRecruits([]);
    setRecruit(null);
    setContacts([]);
    setOpportunities([]);
    setSelected([]);
    setDetail(null);
    setSubmitted(null);
    setSendResults([]);
    setError('');
    setMessage('');
    setProjectForm(blankProject);
    setRecruitForm(blankRecruitment);
    setViewers('');
    setRoleSubject('');
    setTransferTo('');
    setNote('');
    setResponseNotes({});
    setSearched(false);
    setDiscoveryPreferences(null);
    setProjectPreferences(null);
    const refresh = () => {
      if (!active || document.visibilityState !== 'visible' || !writable || working.current || reading) return;
      reading=true;
      void client!.pending().then((value: any[])=>{if(active&&!working.current)setPending(value);}).catch(()=>{}).finally(()=>{reading=false;});
    };
    refresh();
    const timer = window.setInterval(refresh, 20000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      active=false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [runtime, subjectId, connected]);
  async function run(fn: () => Promise<void>) {
    if (working.current) return;
    working.current=true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await fn();
    } catch (e: any) {
      setError(
        e.resultUnknown
          ? `${e.message} 操作结果未知，请查看下方原操作。`
          : e.message,
      );
    } finally {
      if (writable)
        try {
          setPending(await client.pending());
        } catch {}
      working.current=false;
      setBusy(false);
    }
  }
  const viewScope=projectViewScope(runtime,connected);
  const read = async (path: string, input?: any) => {
    if(projectViewScope(runtime,connected)!==viewScope)throw new Error('身份或连接已改变，请重新读取。');
    const result=await runtime.api.call(path, input, {
      authenticated: connected,
      ...(input === undefined ? { method: 'GET' } : {}),
    });
    if(projectViewScope(runtime,connected)!==viewScope)throw new Error('身份或连接已改变，请重新读取。');
    return result;
  };
  useEffect(()=>{
    let active=true;
    if(['discover','projects','recruitment','contacts'].includes(initialTab))setTab(initialTab);
    if(runtime&&initialProjectId&&/^[0-9a-f-]{36}$/.test(initialProjectId)){
      read('/v2/projects/'+initialProjectId).then(value=>{if(active){editProject(value);setProjects([value]);}})
        .catch(e=>{if(active){editProject(null);setError(typeof e?.message==='string'&&e.message.trim()?e.message:'项目详情暂未读取成功，请重新打开或刷新。');}});
    }
    return()=>{active=false;};
  },[runtime,viewScope,initialTab,initialProjectId]);
  async function loadProjects(after?: string) {
    const page = await read('/v2/projects/query', {
      limit: 20,
      ...(after ? { after } : {}),
    });
    setProjects((old) => (after ? [...old, ...page.items] : page.items));
    setProjectNext(page.nextAfter);
  }
  async function loadRecruitments(after?: string) {
    const page = await read('/v2/recruitment/query', {
      view: 'managed',
      limit: 20,
      ...(after ? { after } : {}),
    });
    setRecruits((old) => (after ? [...old, ...page.items] : page.items));
    setRecruitNext(page.nextAfter);
  }
  async function loadContacts(after?: string) {
    const page = await read('/v2/contacts/query', {
      direction,
      limit: 20,
      ...(after ? { after } : {}),
    });
    setContacts((old) => (after ? [...old, ...page.items] : page.items));
    setContactNext(page.nextAfter);
  }
  function editProject(value: any) {
    setProject(value);
    if (value?.document)
      setProjectForm({
        ...blankProject,
        ...value.document,
        functions: value.document.functions.join('、'),
        technologies: value.document.technologies.join('、'),
      });
    else setProjectForm(blankProject);
    setViewers('');
    setVisibility(value?.visibility ?? 'Private');
    setProjectPreferences(null);
  }
  function editRecruitment(value: any) {
    setRecruit(value);
    setRecruitProjectId(value?.projectId ?? project?.projectId ?? '');
    setRecruitForm(
      value?.document
        ? {
            ...value.document,
            functions: value.document.functions.join('、'),
            technologies: value.document.technologies.join('、'),
            days: 30,
          }
        : blankRecruitment,
    );
  }
  async function projectWrite(event: any, extraViewers: string[] = []) {
    const receipt = await client.submit(
      'project',
      {
        projectId: project?.projectId ?? crypto.randomUUID(),
        expectedRevision: project?.revision ?? 0,
        ...event,
      },
      {
        visibility,
        viewers: [...tags(viewers), ...extraViewers],
        confirmed: true,
      },
    );
    setMessage(`项目操作已接收，版本 ${receipt.revision}。`);
    await loadProjects();
    try {
      editProject(await read('/v2/projects/' + receipt.projectId));
    } catch {
      editProject(null);
      setMessage(
        `项目操作已接收，版本 ${receipt.revision}；当前身份不能读取其现有完整资料。`,
      );
    }
  }
  async function saveProject() {
    const document = {
      ...projectForm,
      functions: tags(projectForm.functions),
      technologies: tags(projectForm.technologies),
    };
    if (!document.sourceUrl) delete document.sourceUrl;
    if (!project) await projectWrite({ kind: 'create', document });
    else {
      const patch = { ...document };
      if (!projectForm.sourceUrl) patch.sourceUrl = null;
      if (!project.permissions.manage) {
        delete patch.discoverable;
        delete patch.participantKind;
      }
      await projectWrite({ kind: 'revise', patch });
    }
  }
  async function recruitWrite(kind: string, extra: any = {}) {
    const id = recruit?.recruitmentId ?? crypto.randomUUID();
    let event: any = {
      kind,
      recruitmentId: id,
      projectId: recruit?.projectId ?? recruitProjectId,
      expectedRevision: recruit?.revision ?? 0,
      ...extra,
    };
    if (['create', 'revise', 'renew'].includes(kind)) {
      const { days, ...fields } = recruitForm;
      event = {
        ...event,
        document: {
          ...fields,
          functions: tags(fields.functions),
          technologies: tags(fields.technologies),
          contactSubjectId: subjectId,
        },
        expiresAt: Math.floor(Date.now() / 1000) + Number(days) * 86400,
      };
    }
    await client.submit('recruitment', event, {
      visibility: ['create', 'revise', 'renew'].includes(kind)
        ? 'Public'
        : 'Private',
      confirmed: true,
    });
    setMessage('招募操作已接收；已有任务保持自己的状态。');
    await loadRecruitments();
    // An owner may close a source that is no longer publicly readable. The write receipt is still valid.
    try {
      setRecruit(await read('/v2/recruitment/' + id));
    } catch {
      setRecruit(null);
    }
  }
  async function search(after?: string) {
    const request = after
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
    const page = await read('/v2/discovery/query', {
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
    }
  }
  async function inspect(item: any, after?: string) {
    setDetail(
      await read('/v2/discovery/detail', {
        ...submitted,
        opportunityRef: item.opportunityRef,
        ...(after ? { experienceAfter: after } : {}),
      }),
    );
  }
  async function sendSelected() {
    if (!note.trim()) throw new Error('请填写准备分别发送的说明。');
    const results = [];
    for (const item of opportunities.filter((x) => selected.includes(x.id))) {
      try {
        const result = await client.submit(
          'contact',
          {
            kind: 'send',
            contactId: crypto.randomUUID(),
            expectedRevision: 0,
            recipientId: item.subjectId,
            purpose: submitted.purposes[0],
            context: submitted.context,
            opportunityRef: item.opportunityRef,
            note,
            roomTitle,
          },
          { viewers: [item.subjectId], confirmed: true },
        );
        results.push({ id: item.id, subjectId: item.subjectId, result });
      } catch (e: any) {
        results.push({
          id: item.id,
          subjectId: item.subjectId,
          error: e.message,
          unknown: !!e.resultUnknown,
          operationId: e.operationId,
        });
      }
      setSendResults([...results]);
    }
    setSelected([]);
    await loadContacts();
  }
  async function respond(contact: any, kind: string) {
    const result = await client.submit(
      'contact',
      {
        kind,
        contactId: contact.contactId,
        expectedRevision: contact.revision,
        note: responseNotes[contact.contactId] ?? '',
      },
      { viewers: [contact.initiatorId, contact.recipientId], confirmed: true },
    );
    setMessage(stateNames[result.state] ?? result.state);
    await loadContacts();
  }
  const field = (
    label: string,
    key: string,
    form: any,
    set: (x: any) => void,
    multiline = false,
  ) => (
    <label>
      {label}
      {multiline ? (
        <Textarea
          value={form[key]}
          onChange={(e) => set({ ...form, [key]: e.target.value })}
        />
      ) : (
        <Input
          value={form[key]}
          onChange={(e) => set({ ...form, [key]: e.target.value })}
        />
      )}
    </label>
  );
  return (
    <section>
      <div className="eyebrow">项目、交流与持续协作</div>
      <h1 className="small">项目与联系</h1>
      <p className="lead">
        可以先带着一个目标找人，也可以保存项目、发布长期招募。联系清单与对方实际回应分开显示。
      </p>
      <div className="button-row">
        {[
          ['discover', '找人交流'],
          ['projects', '项目管理'],
          ['recruitment', '长期招募'],
          ['contacts', '联系与回应'],
        ].map(([id, title]) => (
          <Button
            key={id}
            variant={tab === id ? 'default' : 'outline'}
            onClick={() => {
              setTab(id);
              if (writable)
                run(async () => {
                  if (id === 'projects') await loadProjects();
                  if (id === 'recruitment') {
                    await loadProjects();
                    await loadRecruitments();
                  }
                  if (id === 'contacts') await loadContacts();
                });
            }}
          >
            {title}
          </Button>
        ))}
      </div>
      {!connected && (
        <p className="message">
          可以公开查询；保存、联系和回应前请先连接身份。
          <Button variant="ghost" onClick={() => navigate('/app/settings/identity')}>
            身份与连接
          </Button>
        </p>
      )}
      {error && (
        <div className="message error" role="alert">
          {error}
        </div>
      )}
      {message && (
        <div className="message" role="status">
          {message}
        </div>
      )}
      {!!pending.length && (
        <section className="task-body">
          <h2>原操作结果待确认</h2>
          <p>
            先查询当前对象；重试保持原对象、原操作 ID
            和已取得的签名。查询到对象不等于这次修改已经成功。
          </p>
          {pending.map((item) => (
            <article key={item.operationId}>
              <code>
                {item.type} · {item.objectId}
              </code>
              <div className="button-row">
                <Button
                  disabled={busy}
                  variant="outline"
                  onClick={() =>
                    run(async () => {
                      const r = await client.reconcile(item.operationId);
                      setMessage(
                        `当前对象${r.current ? '可读取' : '暂不可读取'}；原操作是否接收仍需精确回执。`,
                      );
                    })
                  }
                >
                  查询当前对象
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await client.reconcile(item.operationId, {
                        retry: true,
                        confirmed: true,
                      });
                      setMessage('原操作已取得匹配回执。');
                    })
                  }
                >
                  重试原操作
                </Button>
              </div>
            </article>
          ))}
        </section>
      )}
      {tab === 'discover' && (
        <>
          <form
            className="workspace-form"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => search());
            }}
          >
            {field('当前目标', 'title', query, setQuery)}
            {field('相关功能，用逗号分隔', 'functions', query, setQuery)}
            {field('技术或环境（可选）', 'technologies', query, setQuery)}
            <label>
              这次交流的目的
              <select
                value={query.purpose}
                onChange={(e) =>
                  setQuery({ ...query, purpose: e.target.value })
                }
              >
                {Object.entries(purposeNames).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v as string}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" disabled={busy || !runtime}>
              查询当前机会
            </Button>
          </form>
          <div className="result-list">
            {opportunities.map((item) => (
              <article className="task-card" key={item.id}>
                <label>
                  <input
                    type="checkbox"
                    disabled={!writable || busy}
                    checked={selected.includes(item.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, item.id]
                          : selected.filter((x) => x !== item.id),
                      )
                    }
                  />{' '}
                  选择联系 {item.project.title}
                </label>
                <p>{item.help.statement}</p>
                <p className="muted">
                  {item.subjectId} · {item.help.functions.join('、')} ·
                  愿意交流不代表承诺交付
                </p>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => run(() => inspect(item))}
                >
                  查看参与条件和真实依据
                </Button>
              </article>
            ))}
          </div>
          {searched && !opportunities.length && (
            <p className="empty-state">
              本页没有可见机会。可以继续下一范围或调整目标；没有可见历史也不代表没有能力。
            </p>
          )}
          {queryNext && (
            <Button
              disabled={busy}
              variant="outline"
              onClick={() => run(() => search(queryNext))}
            >
              继续下一范围
            </Button>
          )}
          {detail && (
            <article className="task-body">
              <h2>{detail.opportunity.project.title}</h2>
              <p>{detail.opportunity.project.summary}</p>
              <p>
                这些资料由你或用户端模型结合当前问题判断；声明、实际参与和验证分别成立。
              </p>
              {detail.experience.items.map((item: any) => (
                <details key={item.key}>
                  <summary>{item.title ?? item.kind}</summary>
                  <FactDetails item={item} />
                </details>
              ))}
              {!detail.experience.items.length && (
                <p>当前没有可见经历，仍可了解具体帮助及条件。</p>
              )}
              {(detail.experience.nextCursor ??
                detail.experience.nextAfter) && (
                <Button
                  variant="outline"
                  onClick={() =>
                    run(() =>
                      inspect(
                        detail.opportunity,
                        detail.experience.nextCursor ??
                          detail.experience.nextAfter,
                      ),
                    )
                  }
                >
                  下一页依据
                </Button>
              )}
            </article>
          )}
          {!!selected.length && (
            <form
              className="workspace-form"
              onSubmit={(e) => {
                e.preventDefault();
                run(sendSelected);
              }}
            >
              <h2>准备分别联系 {selected.length} 个对象</h2>
              <p>
                目标：{submitted.context.title ?? submitted.context.projectId} ·
                目的：{purposeNames[submitted.purposes[0]]}
                。使用这次清单的精确版本。
              </p>
              <label>
                分别发送的说明
                <Textarea
                  required
                  maxLength={2000}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              <label>
                双方接受后的普通房间名称
                <Input
                  required
                  maxLength={120}
                  value={roomTitle}
                  onChange={(e) => setRoomTitle(e.target.value)}
                />
              </label>
              <p>
                每人独立接收和回应。不会建立等待房间，也不会自动把多位候选加入同一房间。
              </p>
              <Button type="submit" disabled={busy || !writable}>
                确认向所选对象分别发送
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setSelected([])}
              >
                取消选择
              </Button>
            </form>
          )}
          {!!sendResults.length && (
            <section>
              <h2>本次发送结果</h2>
              {sendResults.map((item) => (
                <p key={item.id}>
                  {item.subjectId}：
                  {item.result
                    ? stateNames[item.result.state]
                    : item.unknown
                      ? '结果未知，保留原操作待查询'
                      : `未发送成功：${item.error}`}
                </p>
              ))}
              <Button variant="outline" onClick={() => setTab('contacts')}>
                查看实际联系与回应
              </Button>
            </section>
          )}
        </>
      )}
      {tab === 'projects' && (
        <>
          <div className="button-row">
            <Button
              disabled={busy || !writable}
              onClick={() => run(() => loadProjects())}
            >
              刷新我的项目与转交待办
            </Button>
            <Button variant="outline" onClick={() => editProject(null)}>
              准备新项目
            </Button>
          </div>
          {projects.map((item) => (
            <article className="task-card" key={item.projectId}>
              <h2>{item.document?.title ?? '待接受的项目转交'}</h2>
              <p>
                {item.document?.summary ??
                  '原资料尚未向你开放。请原所有者明确分享必要资料，再决定是否接受。'}
              </p>
              <p>
                {item.ownRoles.join('、') || '待受让'} · 版本 {item.revision}
              </p>
              <Button variant="outline" onClick={() => editProject(item)}>
                打开项目与待办
              </Button>
              <Button type="button" variant="ghost" onClick={()=>navigate('/app/projects/'+item.projectId)}>打开项目固定链接</Button>
            </article>
          ))}
          {projectNext && (
            <Button
              disabled={busy}
              onClick={() => run(() => loadProjects(projectNext))}
            >
              更多项目
            </Button>
          )}
          {project && (
            <section className="task-body">
              <code>{project.projectId}</code>
              {project.management?.transfers?.map((t: any) => (
                <article key={t.transferId}>
                  <p>
                    待转交：{t.fromSubjectId} → {t.toSubjectId}
                  </p>
                  {t.toSubjectId === subjectId ? (
                    <Button
                      disabled={busy || !writable || !project.document}
                      onClick={() =>
                        run(() =>
                          projectWrite(
                            {
                              kind: 'accept-transfer',
                              transferId: t.transferId,
                            },
                            [t.fromSubjectId],
                          ),
                        )
                      }
                    >
                      我接受这项管理转交
                    </Button>
                  ) : (
                    project.permissions.manage && (
                      <Button
                        disabled={busy}
                        variant="outline"
                        onClick={() =>
                          run(() =>
                            projectWrite(
                              {
                                kind: 'cancel-transfer',
                                transferId: t.transferId,
                              },
                              [t.toSubjectId],
                            ),
                          )
                        }
                      >
                        取消尚未接受的转交
                      </Button>
                    )
                  )}
                </article>
              ))}
            </section>
          )}
          {(!project || project.permissions.edit) && (
            <form
              className="workspace-form"
              onSubmit={(e) => {
                e.preventDefault();
                run(saveProject);
              }}
            >
              <h2>{project ? '编辑项目资料' : '保存新的项目或模块'}</h2>
              <label>
                类别
                <select
                  value={projectForm.kind}
                  onChange={(e) =>
                    setProjectForm({ ...projectForm, kind: e.target.value })
                  }
                >
                  <option value="project">项目</option>
                  <option value="module">模块</option>
                </select>
              </label>
              {field('名称', 'title', projectForm, setProjectForm)}
              {field('介绍', 'summary', projectForm, setProjectForm, true)}
              {field('实际功能', 'functions', projectForm, setProjectForm)}
              {field('技术', 'technologies', projectForm, setProjectForm)}
              {field(
                'HTTPS 来源地址（可选）',
                'sourceUrl',
                projectForm,
                setProjectForm,
              )}
              {(!project || project.permissions.manage) && (
                <>
                  <label>
                    参与主体（自报）
                    <select
                      value={projectForm.participantKind}
                      onChange={(e) =>
                        setProjectForm({
                          ...projectForm,
                          participantKind: e.target.value,
                        })
                      }
                    >
                      {[
                        ['unknown', '未说明'],
                        ['human', '人'],
                        ['agent', 'Agent'],
                        ['team', '团队'],
                        ['tool', '工具'],
                      ].map(([id, text]) => (
                        <option key={id} value={id}>
                          {text}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={projectForm.discoverable}
                      onChange={(e) =>
                        setProjectForm({
                          ...projectForm,
                          discoverable: e.target.checked,
                        })
                      }
                    />{' '}
                    允许该项目参与发现（还需符合本人发现偏好）
                  </label>
                </>
              )}
              <label>
                本次资料的展示范围
                <select
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value)}
                >
                  <option value="Private">本人及明确选定的身份</option>
                  <option value="Public">公开</option>
                </select>
              </label>
              {visibility === 'Private' && (
                <label>
                  明确可读取的身份 ID（可选，逗号分隔）
                  <Textarea
                    value={viewers}
                    onChange={(e) => setViewers(e.target.value)}
                  />
                </label>
              )}
              <Button type="submit" disabled={busy || !writable}>
                {visibility === 'Public'
                  ? '确认公开保存资料'
                  : '确认按所选范围保存资料'}
              </Button>
            </form>
          )}
          {project?.permissions.manage && (
            <section className="workspace-form">
              <h2>共同管理与对外代表</h2>
              <p>
                编辑资料、代表项目和管理转交分别授权。它们不包含他人的私有文件、房间和
                Agent 控制权。
              </p>
              {project.management?.roles?.map((r: any) => (
                <p key={r.subjectId + r.role}>
                  {r.subjectId} ·{' '}
                  {r.role === 'editor' ? '资料编辑' : '对外代表'}{' '}
                  <Button
                    disabled={busy}
                    variant="outline"
                    onClick={() =>
                      run(() =>
                        projectWrite(
                          {
                            kind: 'revoke-role',
                            subjectId: r.subjectId,
                            role: r.role,
                          },
                          [r.subjectId],
                        ),
                      )
                    }
                  >
                    撤销该角色
                  </Button>
                </p>
              ))}
              <label>
                身份 ID
                <Input
                  value={roleSubject}
                  onChange={(e) => setRoleSubject(e.target.value)}
                />
              </label>
              <label>
                角色
                <select value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="editor">资料编辑</option>
                  <option value="representative">对外代表</option>
                </select>
              </label>
              <Button
                disabled={busy || !writable}
                onClick={() =>
                  run(() =>
                    projectWrite(
                      { kind: 'grant-role', subjectId: roleSubject, role },
                      [roleSubject],
                    ),
                  )
                }
              >
                授予所选角色
              </Button>
              <label>
                受让人身份 ID
                <Input
                  value={transferTo}
                  onChange={(e) => setTransferTo(e.target.value)}
                />
              </label>
              <p>
                先确保受让人可读取必要的项目资料。发出邀请仍由你管理，只有受让人接受后才转交。
              </p>
              <Button
                disabled={busy || !writable}
                variant="outline"
                onClick={() =>
                  run(() =>
                    projectWrite(
                      {
                        kind: 'offer-transfer',
                        transferId: crypto.randomUUID(),
                        toSubjectId: transferTo,
                      },
                      [transferTo],
                    ),
                  )
                }
              >
                发出管理转交邀请
              </Button>
              <Button
                disabled={busy}
                variant="outline"
                onClick={() =>
                  run(() =>
                    projectWrite({
                      kind: project.state === 'active' ? 'archive' : 'restore',
                    }),
                  )
                }
              >
                {project.state === 'active' ? '归档项目' : '恢复项目'}
              </Button>
            </section>
          )}
        </>
      )}
      {tab === 'recruitment' && (
        <>
          <div className="button-row">
            <Button
              disabled={busy || !writable}
              onClick={() =>
                run(async () => {
                  await loadProjects();
                  await loadRecruitments();
                })
              }
            >
              刷新管理中的招募
            </Button>
            <Button variant="outline" onClick={() => editRecruitment(null)}>
              准备新招募
            </Button>
          </div>
          {recruits.map((item) => (
            <article className="task-card" key={item.recruitmentId}>
              <h2>{item.document?.title ?? '当前声明不可读取'}</h2>
              <p>
                {stateNames[item.state] ?? item.state} · {item.document?.role} ·{' '}
                {item.expiresAt
                  ? new Date(item.expiresAt).toLocaleString()
                  : ''}
              </p>
              <Button variant="outline" onClick={() => editRecruitment(item)}>
                管理这项招募
              </Button>
            </article>
          ))}
          {recruitNext && (
            <Button
              disabled={busy}
              onClick={() => run(() => loadRecruitments(recruitNext))}
            >
              下一页招募
            </Button>
          )}
          <form
            className="workspace-form"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => recruitWrite(recruit ? 'revise' : 'create'));
            }}
          >
            <h2>{recruit ? '修订当前招募' : '公开持续角色需求'}</h2>
            <label>
              由你管理或代表的项目
              <select
                disabled={!!recruit}
                value={recruitProjectId}
                onChange={(e) => setRecruitProjectId(e.target.value)}
              >
                <option value="">选择项目</option>
                {projects
                  .filter((p) => p.permissions.represent)
                  .map((p) => (
                    <option key={p.projectId} value={p.projectId}>
                      {p.document?.title ?? p.projectId}
                    </option>
                  ))}
              </select>
            </label>
            {field('招募名称', 'title', recruitForm, setRecruitForm)}
            {field('需要什么角色', 'role', recruitForm, setRecruitForm)}
            {field('具体说明', 'summary', recruitForm, setRecruitForm, true)}
            {field('相关功能', 'functions', recruitForm, setRecruitForm)}
            {field('技术（可选）', 'technologies', recruitForm, setRecruitForm)}
            {field(
              '参与条件与时间（可选）',
              'conditions',
              recruitForm,
              setRecruitForm,
              true,
            )}
            <label>
              从本次发布起有效天数
              <Input
                type="number"
                min={1}
                max={30}
                required
                value={recruitForm.days}
                onChange={(e) =>
                  setRecruitForm({
                    ...recruitForm,
                    days: Number(e.target.value),
                  })
                }
              />
            </label>
            <p>
              公开项目及当前代表权是前提。你是本次真实接触人；发布、修订和续期共用公开任务发布额度。不会创建赏金或任务。
            </p>
            <Button
              type="submit"
              disabled={
                busy ||
                !writable ||
                !recruitProjectId ||
                recruit?.state === 'closed'
              }
            >
              确认公开{recruit ? '修订' : '发布'}
            </Button>
            {recruit && (
              <div className="button-row">
                <Button
                  type="button"
                  disabled={busy || recruit.state === 'closed'}
                  variant="outline"
                  onClick={() => run(() => recruitWrite('renew'))}
                >
                  按上面内容和期限续期
                </Button>
                <Button
                  type="button"
                  disabled={busy || recruit.state === 'closed'}
                  variant="outline"
                  onClick={() => run(() => recruitWrite('pause'))}
                >
                  暂停新分发
                </Button>
                <Button
                  type="button"
                  disabled={busy || recruit.state === 'closed'}
                  variant="outline"
                  onClick={() => run(() => recruitWrite('close'))}
                >
                  关闭这项招募
                </Button>
              </div>
            )}
          </form>
          {recruit && (
            <section className="workspace-form">
              <h2>关联已经存在的具体任务</h2>
              <p>
                任务必须由你发起；本次只建立关系，不修改任务状态、参与人或验收。
              </p>
              <label>
                任务 ID
                <Input
                  value={taskId}
                  onChange={(e) => setTaskId(e.target.value)}
                />
              </label>
              <Button
                disabled={busy || !writable}
                onClick={() =>
                  run(async () => {
                    const task = await read('/v2/tasks/' + taskId);
                    await recruitWrite('link-task', {
                      taskId,
                      expectedTaskVersion: task.version,
                    });
                  })
                }
              >
                核对当前版本并关联任务
              </Button>
              {recruit.taskLinks?.map((link: any) => (
                <Button
                  key={link.taskId}
                  variant="ghost"
                  onClick={() => navigate('/app/tasks/' + link.taskId)}
                >
                  打开已关联任务 {link.taskId}
                </Button>
              ))}
            </section>
          )}
        </>
      )}
      {tab === 'contacts' && (
        <>
          <div className="button-row">
            <select
              aria-label="联系方向"
              value={direction}
              onChange={(e) => setDirection(e.target.value)}
            >
              <option value="both">所有实际联系</option>
              <option value="incoming">收到的联系</option>
              <option value="outgoing">我发起的联系</option>
            </select>
            <Button
              disabled={busy || !writable}
              onClick={() => run(() => loadContacts())}
            >
              刷新联系与回应
            </Button>
          </div>
          <p>
            这里记录实际发送与独立回应，建议名单留在“找人交流”。每个联系人分别沟通，多人房间由用户在交流环节另行选择并取得成员同意。
          </p>
          {contacts.map((contact) => (
            <article className="task-card" key={contact.contactId}>
              <h2>{stateNames[contact.state] ?? contact.state}</h2>
              <p>
                {contact.initiatorId} → {contact.recipientId}
              </p>
              {contact.events.map((event: any) => (
                <p key={event.operationId}>
                  {event.kind}：
                  {event.contentUnavailable ? '原文当前不可读取' : event.note}
                </p>
              ))}
              {contact.state === 'sent' && (
                <>
                  <label>
                    本次回应（可选）
                    <Textarea
                      value={responseNotes[contact.contactId] ?? ''}
                      onChange={(e) =>
                        setResponseNotes({
                          ...responseNotes,
                          [contact.contactId]: e.target.value,
                        })
                      }
                    />
                  </label>
                  <div className="button-row">
                    {contact.recipientId === subjectId ? (
                      <>
                        <Button
                          disabled={busy || !writable}
                          onClick={() => run(() => respond(contact, 'accept'))}
                        >
                          我接受普通交流
                        </Button>
                        <Button
                          disabled={busy || !writable}
                          variant="outline"
                          onClick={() => run(() => respond(contact, 'decline'))}
                        >
                          拒绝这次联系
                        </Button>
                      </>
                    ) : (
                      <Button
                        disabled={busy || !writable}
                        variant="outline"
                        onClick={() => run(() => respond(contact, 'withdraw'))}
                      >
                        撤回尚未接受的联系
                      </Button>
                    )}
                  </div>
                </>
              )}
              {contact.state === 'accepted' && contact.roomId && (
                <Button
                  onClick={() => navigate('/app/rooms/' + contact.roomId)}
                >
                  打开双方确认后的普通房间
                </Button>
              )}
            </article>
          ))}
          {!contacts.length && (
            <p className="empty-state">
              当前列表没有实际联系。刷新前或空页不能当作没有任何待办。
            </p>
          )}
          {contactNext && (
            <Button
              disabled={busy}
              onClick={() => run(() => loadContacts(contactNext))}
            >
              下一页联系
            </Button>
          )}
        </>
      )}
      {writable && (
        <details className="room-settings">
          <summary>发现意愿与本项目覆盖</summary>
          <p>
            保存项目不会自动开启长期发现。长期设置、这个项目的覆盖和临时暂停分别维护；明确关闭始终优先。
          </p>
          <Button
            disabled={busy}
            variant="outline"
            onClick={() =>
              run(async () => {
                setDiscoveryPreferences(
                  await read('/v1/discovery/preferences/read', {}),
                );
                if (project?.document)
                  setProjectPreferences(
                    await read(
                      `/v2/projects/${project.projectId}/preferences/read`,
                      {},
                    ),
                  );
              })
            }
          >
            读取当前意愿
          </Button>
          {discoveryPreferences && (
            <div className="workspace-form">
              <p>
                长期发现：
                {discoveryPreferences.preferences.enabled ? '开启' : '关闭'}
                {discoveryPreferences.effective.temporaryUntil
                  ? ' · 当前有临时意愿'
                  : ''}
              </p>
              <fieldset>
                <legend>允许的交流目的</legend>
                {Object.entries(purposeNames).map(([key, value]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={discoveryPreferences.preferences.purposes.includes(
                        key,
                      )}
                      onChange={(e) =>
                        setDiscoveryPreferences({
                          ...discoveryPreferences,
                          preferences: {
                            ...discoveryPreferences.preferences,
                            purposes: e.target.checked
                              ? [
                                  ...discoveryPreferences.preferences.purposes,
                                  key,
                                ]
                              : discoveryPreferences.preferences.purposes.filter(
                                  (p: string) => p !== key,
                                ),
                          },
                        })
                      }
                    />
                    {value as string}
                  </label>
                ))}
              </fieldset>
              <div className="button-row">
                {[true, false].map((enabled) => (
                  <Button
                    key={String(enabled)}
                    disabled={
                      busy || !discoveryPreferences.preferences.purposes.length
                    }
                    variant="outline"
                    onClick={() =>
                      run(async () =>
                        setDiscoveryPreferences(
                          await read('/v1/discovery/preferences/save', {
                            expectedRevision: discoveryPreferences.revision,
                            preferences: {
                              ...discoveryPreferences.preferences,
                              enabled,
                            },
                          }),
                        ),
                      )
                    }
                  >
                    {enabled ? '保存所选目的并开启长期发现' : '关闭长期发现'}
                  </Button>
                ))}
                <Button
                  disabled={busy}
                  variant="outline"
                  onClick={() =>
                    run(async () =>
                      setDiscoveryPreferences(
                        await read('/v1/discovery/preferences/save', {
                          expectedRevision: discoveryPreferences.revision,
                          preferences: {
                            ...discoveryPreferences.preferences,
                            temporary: {
                              until: Math.floor(Date.now() / 1000) + 86400,
                              contact: 'paused',
                            },
                          },
                        }),
                      ),
                    )
                  }
                >
                  暂停接触24小时
                </Button>
                {discoveryPreferences.preferences.temporary && (
                  <Button
                    disabled={busy}
                    variant="outline"
                    onClick={() =>
                      run(async () =>
                        setDiscoveryPreferences(
                          await read('/v1/discovery/preferences/save', {
                            expectedRevision: discoveryPreferences.revision,
                            preferences: {
                              ...discoveryPreferences.preferences,
                              temporary: null,
                            },
                          }),
                        ),
                      )
                    }
                  >
                    取消临时意愿，恢复长期设置
                  </Button>
                )}
              </div>
            </div>
          )}
          {projectPreferences && (
            <div className="button-row">
              <p>
                {project?.document?.title} 的覆盖：
                {projectPreferences.preferences === null
                  ? '沿用长期设置'
                  : projectPreferences.preferences.enabled
                    ? '项目允许'
                    : '本项目关闭'}
              </p>
              {['off', 'on', 'inherit'].map((mode) => (
                <Button
                  key={mode}
                  disabled={busy}
                  variant="outline"
                  onClick={() =>
                    run(async () =>
                      setProjectPreferences(
                        await read(
                          `/v2/projects/${project.projectId}/preferences/save`,
                          {
                            expectedRevision: projectPreferences.revision,
                            preferences:
                              mode === 'inherit'
                                ? null
                                : {
                                    ...(projectPreferences.preferences ??
                                      discoveryPreferences.preferences),
                                    enabled: mode === 'on',
                                    temporary: null,
                                  },
                          },
                        ),
                      ),
                    )
                  }
                >
                  {mode === 'off'
                    ? '仅关闭本项目'
                    : mode === 'on'
                      ? '允许本项目（长期关闭仍优先）'
                      : '恢复沿用长期设置'}
                </Button>
              ))}
            </div>
          )}
        </details>
      )}
      <div className="button-row">
        <Button variant="outline" onClick={() => navigate('/app/publish')}>
          发布具体任务
        </Button>
        <Button variant="outline" onClick={() => navigate('/app/participate')}>
          参与任务
        </Button>
        <Button variant="ghost" onClick={() => navigate('/app/rooms')}>
          普通聊天
        </Button>
      </div>
    </section>
  );
}

