import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ArrowRight } from 'lucide-react';
import { FactDetails } from './fact-details';
import {OpportunityContactWorkspace} from './opportunity-contact-workspace';
import {projectQueryMemory,projectViewScope} from './project-view-client.mjs';

const purposes = [['conversation', '交流想法'], ['reuse', '寻找可复用内容'], ['collaboration', '共同协作'], ['recruitment', '定向招募']];
const tags = (value: string) => [...new Set(value.split(/[,，、\n]/).map(item => item.trim()).filter(Boolean))];
export function DiscoveryWorkspace({ runtime, connected, navigate }: { runtime: any; connected: boolean; navigate: (path: string) => void }) {
  return <DiscoveryView key={projectViewScope(runtime,connected)} runtime={runtime} connected={connected} navigate={navigate}/>;
}
function DiscoveryView({ runtime, connected, navigate }: { runtime: any; connected: boolean; navigate: (path: string) => void }) {
  const [title, setTitle] = useState(''), [functions, setFunctions] = useState(''), [technologies, setTechnologies] = useState('');
  const [selected, setSelected] = useState(['conversation', 'collaboration']), [submitted, setSubmitted] = useState<any>(null);
  const [items, setItems] = useState<any[]>([]), [next, setNext] = useState<string | null>(null), [detail, setDetail] = useState<any>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [searched, setSearched] = useState(false);
  const [otherQuery, setOtherQuery] = useState(''), [kind, setKind] = useState('capsule'), [resources, setResources] = useState<any[]>([]);
  const [capsule, setCapsule] = useState<any>(null);
  const viewScope=projectViewScope(runtime,connected);
  useEffect(() => { setItems([]); setDetail(null); setSubmitted(null); setNext(null); setSearched(false); setResources([]);setCapsule(null);
    const saved=projectQueryMemory(runtime,connected,'discovery');setTitle(saved?.title??'');setFunctions(saved?.functions??'');setTechnologies(saved?.technologies??'');setSelected(saved?.selected??['conversation','collaboration']);
  }, [runtime, viewScope]);
  async function read(path:string,input:any){const result=await runtime.api.call(path,input,{authenticated:connected});if(projectViewScope(runtime,connected)!==viewScope)throw new Error('身份或连接已改变，请重新读取。');return result;}
  async function run(fn: () => Promise<void>) { if (busy) return; setBusy(true); setError(''); try { await fn(); } catch (e: any) { setError(typeof e?.message === 'string' && e.message.trim() ? e.message : '发现操作暂未完成，请稍后重试。'); } finally { setBusy(false); } }
  async function search(after?: string) {
    const query = after ? submitted : { context: { kind: 'ephemeral', title, functions: tags(functions), technologies: tags(technologies) }, purposes: selected };
    const result = await read('/v2/discovery/query', { ...query, limit: 20, ...(after ? { after } : {}) });
    projectQueryMemory(runtime,connected,'discovery',{title,functions,technologies,selected});
    setSubmitted(query); setItems(old => after ? [...old, ...result.items] : result.items); setNext(result.nextAfter); setSearched(true); if (!after) setDetail(null);
  }
  async function inspect(item: any, experienceAfter?: string) {
    try{const result = await read('/v2/discovery/detail', { ...submitted, opportunityRef: item.opportunityRef, ...(experienceAfter ? { experienceAfter } : {}) });setDetail(result);}
    catch(e){setDetail(null);throw e;}
  }
  return <section><div className="eyebrow">把当前工作连接到更多帮助</div><h1 className="small">发现匹配</h1><p className="lead">说说正在做什么，查看相关项目、表达参与意愿的人，以及真实经历。一次查询无需先登记项目，也不会替你发出邀请。</p>
    {error && <div className="message error" role="alert">{error}</div>}
    <form className="workspace-form" onSubmit={e => { e.preventDefault(); run(() => search()); }}>
      <label>当前目标<Input required maxLength={120} value={title} onChange={e => setTitle(e.target.value)} placeholder="例如：为本地工具增加多人协作"/></label>
      <label>希望相关的功能或方向<Textarea required value={functions} onChange={e => setFunctions(e.target.value)} placeholder="权限管理、网页聊天、代码复核；用逗号分隔，最多 16 项"/></label>
      <label>技术与环境（可选）<Input value={technologies} onChange={e => setTechnologies(e.target.value)} placeholder="如 React、PostgreSQL"/></label>
      <fieldset className="purpose-options"><legend>你希望做什么，可以同时存在</legend>{purposes.map(([value, label]) => <label key={value}><input type="checkbox" checked={selected.includes(value)} onChange={e => setSelected(e.target.checked ? [...selected, value] : selected.filter(item => item !== value))}/>{label}</label>)}</fieldset>
      <Button type="submit" disabled={busy || !runtime || !selected.length}>查找当前可见的机会 <ArrowRight size={16}/></Button><p className="muted">相关性由你和用户端模型判断。愿意接触不等于承诺时间、价格或参与。</p>
    </form>
    <div className="result-list">{items.map(item => <article className="task-card" key={item.id}><span className="tag">当前声明与意愿</span><h2>{item.project.title}</h2><p>{item.help.statement}</p><p className="muted">{item.displayName ?? item.subjectId} · 共同方向：{item.help.functions.join('、')} · {item.help.purposes.map((value: string) => purposes.find(p => p[0] === value)?.[1] ?? value).join('、')}</p>
      <Button variant="outline" disabled={busy} onClick={() => run(() => inspect(item))}>查看真实依据与参与条件</Button></article>)}</div>
    {searched && !items.length && <div className="empty-state">这一页没有当前可见的机会。可以继续下一范围、调整描述，或发布任务。没有展示历史不代表没有能力。</div>}
    {next && <Button variant="outline" disabled={busy} onClick={() => run(() => search(next))}>继续查找下一范围</Button>}
    {detail && <section className="task-body discovery-detail"><h2>{detail.opportunity.project.title}</h2><p>{detail.opportunity.project.summary}</p><p className="muted">以下是这个主体当前允许展示的经历，需要结合环境判断与本次工作的相关性。声明、尝试结果和独立验证分别成立；没有历史也可以开始开放协作。</p>
      <code className="identity-id">{detail.opportunity.subjectId}</code>
      <div className="result-list">{detail.experience.items.map((item: any) => <article key={item.key} className="task-card"><h3>{item.title ?? item.kind}</h3><p>{item.summary ?? item.role ?? item.outcome ?? ''}</p><p className="muted">{item.kind} · {item.result?.status ?? item.state ?? ''}</p>
        <details><summary>查看尝试、介入和结果依据</summary><FactDetails item={item}/></details>
        {item.taskId && <Button variant="ghost" onClick={() => navigate(`/app/tasks/${item.taskId}`)}>查看关联任务</Button>}
      </article>)}</div>
      {!detail.experience.items.length && <p>这一页没有可见经历。可以先了解对方提出的具体帮助与条件。</p>}
      {(detail.experience.nextCursor??detail.experience.nextAfter) && <Button variant="outline" disabled={busy} onClick={() => run(() => inspect(detail.opportunity, detail.experience.nextCursor??detail.experience.nextAfter))}>更多经历</Button>}
      <p className="muted">阅读依据不会发出联系请求。你可以带回原聊天比较，也可以在此明确选择下一步。</p>
      <OpportunityContactWorkspace runtime={runtime} connected={connected} query={submitted} opportunity={detail.opportunity} navigate={navigate}/>
      <Button variant="outline" onClick={() => navigate('/app/publish')}>发布我的任务</Button>
    </section>}
    <details className="room-settings"><summary>另查 Capsule、Worker 与 Hub</summary><p className="muted">已有方法与工具是帮助的一部分，不能替代寻找实际协助者。阅读 Capsule 不会被记成成功复用。</p>
      <form className="search-row" onSubmit={e => { e.preventDefault(); run(async () => {
        const result = kind === 'capsule' ? await read('/v2/capsules/query', { query: otherQuery, limit: 10 })
          : await read('/v1/search/query', { type: kind, query: { query: otherQuery, limit: 8 } }); setResources(result.items);
      }); }}><Input required aria-label="查找方法与工具" value={otherQuery} onChange={e => setOtherQuery(e.target.value)}/><select aria-label="方法与工具类型" value={kind} onChange={e => setKind(e.target.value)}><option value="capsule">Capsule</option><option value="worker">Worker</option><option value="hub">Hub</option></select><Button type="submit" disabled={!runtime || busy}>查找</Button></form>
      {resources.map(item => <article className="task-card" key={item.id ?? item.capsuleId}><h3>{item.title}</h3><p>{item.summary}</p>{item.capsuleId ? <Button variant="outline" disabled={busy} onClick={() => run(async () => setCapsule(await read('/v2/capsules/read', { capsuleId: item.capsuleId, versionId: item.versionId })))}>阅读方法及适用限制</Button> : <p className="muted">{item.matchReasons?.join('、')}</p>}</article>)}
      {capsule && <article className="task-body"><h2>{capsule.version?.title ?? '方法来源当前不可用'}</h2>{capsule.version ? <><p>{capsule.version.problemPattern}</p><p>环境：{capsule.version.environment.name} {capsule.version.environment.version}</p><h3>处理方法</h3><p>{capsule.version.solutionStrategy}</p><h3>适用范围</h3><p>{capsule.version.applicableScope}</p><h3>限制</h3><ul>{capsule.version.limitations.map((item: string) => <li key={item}>{item}</li>)}</ul><h3>核验方式</h3><p>{capsule.version.verificationMethod}</p><p className="muted">许可：{capsule.version.license} · {capsule.synthetic ? '合成案例来源' : '来源按实际记录核对'} · {capsule.newApplicationAllowed ? '可结合环境考虑采用' : '当前不应继续新应用'}</p><p className="muted">阅读不会登记成功复用。实际采用后，由用户端模型协助记录尝试、结果和环境差异。</p></> : <p>引用保留，但源材料已不可读取，不能继续将原内容视为可用方法。</p>}</article>}
    </details>
    <div className="button-row"><Button variant="outline" onClick={() => navigate('/app/projects')}>项目与联系</Button><Button variant="outline" onClick={() => navigate('/app/publish')}>发布任务</Button><Button variant="outline" onClick={() => navigate('/app/participate')}>参与任务</Button><Button variant="ghost" onClick={() => navigate('/app/rooms')}>开始普通交流</Button></div>
  </section>;
}
