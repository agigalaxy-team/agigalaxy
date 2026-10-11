import React,{useState} from 'react';
import type {BuilderDeclaration,BuilderSupport,WorkerPack,BuilderReport,BuilderMaintenance,BuilderPreview} from './builder-authoring-state';
import {memberName} from './conversation-ui';

export const builderKinds:Record<string,string>={worker:'Agent / Worker',bridge:'外部来源适配',hub:'社区 / Hub'};
const actions:Record<string,string>={'identity.reference':'引用身份','case.read':'读取工作','case.write':'记录工作','attempt.read':'读取尝试','attempt.write':'记录尝试','attempt.map':'映射尝试','intervention.read':'读取介入','intervention.write':'记录介入','result.read':'读取结果','result.write':'记录结果','result.map':'映射结果','evidence.read':'读取证据','evidence.write':'记录证据','evidence.import':'导入证据','verification.read':'读取检查','verification.write':'记录检查','proof.read':'读取证明','proof.export':'导出证明','history.read':'读取经历','history.export':'导出经历','configuration.read':'读取配置','configuration.write':'记录配置','consent.revoke':'撤回授权','task.read':'读取求助','task.apply':'表达参与意向','worker.execute':'执行已授权工作','hub.core':'社区基础功能','peering.query':'社区互联查询'};
export const builderActionName=(id:string)=>actions[id]??id;
const reportStatusNames:Record<string,string>={pass:'报告通过',fail:'报告未通过','not-tested':'未测试'};
const mappingMeanings:Record<string,string>={'source-fact':'来源事实','source-claim':'来源自述',derived:'推导',unknown:'未知'};
const kinds:Record<string,string>={declare:'登记资料', 'support-profile':'支持范围','pack-manifest':'Pack 清单','scope-report':'范围实测报告',maintenance:'维护公告'};
const Paragraph=({title,children}:{title:string;children:React.ReactNode})=><section className="professional-section"><h3>{title}</h3><div className="reading-prose">{children}</div></section>;
const TextList=({values}:{values:(string|{name:string;version:string})[]})=><ul className="plain-record-list">{values.map((v,i)=><li key={i}>{typeof v==='string'?v:`${v.name} ${v.version}`}</li>)}</ul>;
const Ref=({href,children}:{href:string;children:React.ReactNode})=><a href={href} target="_blank" rel="noreferrer">{children}</a>;
export const builderTestNames:Record<string,string>={format:'格式检查','source-flow':'源码流程','independent-interop':'独立互通','host-experience':'宿主使用'};
export const builderMaintenanceNames:Record<string,string>={delist:'下架',relist:'恢复上架',correction:'纠正说明','security-issue':'安全问题','resolve-security':'安全问题已处理'};

export function BuilderNotices({items}:{items:(BuilderMaintenance&{revision:number;eventId?:string})[]}){const [all,setAll]=useState(false);if(!items?.length)return null;const shown=(all?items:items.slice(-2)).slice().reverse();return <section className="professional-section"><h2>维护与变化</h2><ol className="plain-record-list">{shown.map(item=><li key={item.eventId??item.id}><h3>{builderMaintenanceNames[item.action]??item.action}</h3><p className="reading-prose">{item.summary}</p><p className="record-meta">第 {item.revision} 次登记更新</p></li>)}</ol>{items.length>2&&<button className="text-link" onClick={()=>setAll(v=>!v)}>{all?'收起较早公告':'阅读此前的维护公告'}</button>}</section>;}

export function BuilderScopeReportView({value:e}:{value:BuilderReport}){return <div className="professional-record"><p><Ref href={e.suite.source}>{e.suite?.name} {e.suite?.version}</Ref></p><p>验证方式：{builderTestNames[e.run.testClass]??e.run.testClass}</p><p className="reading-prose">{e.run.environment}</p><p>运行：{e.run.id} · 执行器 {e.run.runnerVersion}</p>{e.run.peer&&<p>互通对象：{e.run.peer.name} {e.run.peer.version}</p>}<p>观察于 {new Date(e.observedAt*1000).toLocaleString('zh-CN')}，适用至 {new Date(e.expiresAt*1000).toLocaleString('zh-CN')}。</p><ul className="plain-record-list">{e.checks?.map((c)=><li key={c.action}><strong>{builderActionName(c.action)}</strong> · {reportStatusNames[c.status]}<p className="reading-prose">{c.detail}</p></li>)}</ul><p className="reading-prose">报告限制：{e.limitations}</p><details className="technical-details"><summary>用于复核的准确版本</summary><dl><dt>测试套件 SHA-256</dt><dd>{e.suite.sha256}</dd><dt>受测源码 SHA-256</dt><dd>{e.run.sourceHash}</dd><dt>报告 SHA-256</dt><dd>{e.run.reportHash}</dd></dl></details></div>;}

export function BuilderDeclarationView({value:d}:{value?:BuilderDeclaration|null}){
  if(!d)return null;
  return <div className="professional-record">
    <p className="record-meta">{builderKinds[d.type]??d.type} · {d.release?.version}</p>
    <Paragraph title="适用范围"><p>{d.scope}</p></Paragraph>
    {d.type==='worker'&&<><Paragraph title="配置与能力"><p>{d.configuration?.summary}</p><p>模型：{d.configuration?.modelFamily} · 同时处理上限：{d.configuration?.maxConcurrentTasks}</p><TextList values={d.configuration?.taskTypes??[]}/>{d.capabilities?.map((c)=><article key={c.id}><h4>{c.claim}</h4><p>限制：{c.limitations}</p></article>)}</Paragraph>{d.configuration?.tools?.length>0&&<Paragraph title="使用的工具"><TextList values={d.configuration.tools}/></Paragraph>}</>}
    {d.type==='bridge'&&d.mapping&&<><Paragraph title="来源如何映射"><p>{d.mapping.sourceSystem} · 映射版本 {d.mapping.version}</p><p>{d.mapping.rules}</p><p>来源对象：{d.mapping.sourceObjects?.join('、')}</p><p>目标对象：{d.mapping.targetObjects?.join('、')}</p><p>记录强度上限：{d.mapping.strengthCeiling==='execution-observation'?'执行观察':'来源自述'}</p></Paragraph><Paragraph title="授权与来源追溯"><p>{d.mapping.authorization}</p><p>{d.mapping.provenance}</p><p>去重：{d.mapping.deduplication}</p><p>撤回：{d.mapping.revocation}</p></Paragraph></>}
    {d.type==='hub'&&<><Paragraph title="运营与使用"><p>{d.operator} · {d.region}</p><p><Ref href={d.charter}>社区章程</Ref></p><p>退出：{d.exit}</p><p>导出：{d.export}</p><p><Ref href={d.endpoint}>社区服务</Ref> · <Ref href={d.manifest.url}>社区清单</Ref>（{d.manifest.specVersion}）</p></Paragraph></>}
    {d.type==='worker'&&d.a2a&&<Paragraph title="对外 Agent 接口"><p><Ref href={d.a2a.endpoint}>A2A 服务端点</Ref> · <Ref href={d.a2a.cardUrl}>Agent Card</Ref></p><p>{d.a2a.protocol} / {d.a2a.transport}{d.a2a.tenant?' · 租户 '+d.a2a.tenant:''}</p></Paragraph>}
    {d.release&&<Paragraph title="版本与维护"><p><Ref href={d.release.artifact}>作者提供的发布文件</Ref></p><p>升级：{d.release.upgrade}</p><p>回退：{d.release.rollback}</p>{d.release.dependencies?.length>0&&<TextList values={d.release.dependencies}/>}</Paragraph>}
    <div className="record-links"><Ref href={d.policy}>使用政策</Ref><Ref href={d.contact}>联系作者</Ref></div>
  </div>;
}

export function BuilderSupportView({value:s}:{value?:BuilderSupport|null}){
  if(!s)return null;
  return <div className="professional-record"><p>{s.implementation?.name} {s.implementation?.version} · {s.galaxySchema}</p>{(s.protocols?.length>0||s.sdks?.length>0)&&<Paragraph title="协议与 SDK">{s.protocols?.length>0&&<><h4>协议</h4><TextList values={s.protocols}/></>}{s.sdks?.length>0&&<><h4>SDK</h4><TextList values={s.sdks}/></>}</Paragraph>}<Paragraph title="可用操作"><ul className="scope-chip-list">{s.objectActions?.map((a:string)=><li key={a}>{builderActionName(a)}</li>)}</ul></Paragraph><Paragraph title="限制与缺项"><p>{s.limitations}</p><p>{s.missingCapabilities?.length?s.missingCapabilities.map(builderActionName).join('、'):'作者未另列缺项。'}</p></Paragraph><Paragraph title="授权条件"><p>{s.authorization}</p></Paragraph>{s.mapping&&<Paragraph title="来源映射"><p>{s.mapping.sourceSystem} · {s.mapping.version}</p><div className="table-scroll"><table><thead><tr><th>来源字段</th><th>目标字段</th><th>含义</th><th>规则</th></tr></thead><tbody>{s.mapping.fields?.map((f,i)=><tr key={i}><td>{f.source}</td><td>{f.target}</td><td>{mappingMeanings[f.meaning]??f.meaning}</td><td>{f.rule}</td></tr>)}</tbody></table></div><p>来源身份：{s.mapping.sourceIdentity}</p><p>去重：{s.mapping.deduplication}</p><p>观察时间：{s.mapping.observationTime}</p><p>授权：{s.mapping.authorization}</p><p>撤回：{s.mapping.revocation}</p><p>排除资料：{s.mapping.excludedData}</p></Paragraph>}</div>;
}

export function WorkerPackView({value:p}:{value?:WorkerPack|null}){
  if(!p)return null;
  return <div className="professional-record"><p className="record-meta">{p.name} {p.version} · <Ref href={p.licenseSource}>{p.license}</Ref></p><Paragraph title="这个版本能做什么"><TextList values={p.capabilities??[]}/><p>{p.changes}</p></Paragraph><Paragraph title="运行条件"><p>{p.modelRequirements}</p><p>{p.environment}</p><p>{p.configurationRequirements}</p></Paragraph>{p.permissions?.length>0&&<Paragraph title="需要的权限"><ul className="plain-record-list">{p.permissions.map((a,i)=><li key={i}><strong>{a.resource}</strong> · {a.required?'必需':'可选'}<p>{a.purpose}</p></li>)}</ul></Paragraph>}{p.dependencies?.length>0&&<Paragraph title="依赖"><ul className="plain-record-list">{p.dependencies.map((a,i)=><li key={i}><Ref href={a.source}>{a.name} {a.version}</Ref> · {a.license}</li>)}</ul></Paragraph>}<Paragraph title="安装与维护"><p>安装：{p.installation}</p><p>升级：{p.upgrade}</p><p>回退：{p.rollback}</p></Paragraph><p><Ref href={p.source}>查看作者来源</Ref></p></div>;
}

export function BuilderEventPreview({value,names={},subjectId}:{value:BuilderPreview;names?:Record<string,string|null>;subjectId?:string}){
  const e=value.event;
  return <section className="professional-preview"><h2>{kinds[e.kind]??'资料预览'}</h2><p className="permission-line">{value.visibility==='Public'?'公开':`本人${value.viewers?.length?'及 '+value.viewers.map((v:string)=>memberName(v,subjectId,names[v]??undefined)).join('、'):''}`}可见。</p>
    {e.kind==='declare'&&<><h3>{e.declaration.name}</h3><BuilderDeclarationView value={e.declaration}/></>}
    {e.kind==='support-profile'&&<BuilderSupportView value={e.support}/>}
    {e.kind==='pack-manifest'&&<WorkerPackView value={e.manifest}/>}
    {e.kind==='maintenance'&&<><p>{builderMaintenanceNames[e.action]??e.action}</p><p className="reading-prose">{e.summary}</p></>}
    {e.kind==='scope-report'&&<BuilderScopeReportView value={e}/>}
  </section>;
}
