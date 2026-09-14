import React from 'react';
const outcomes: Record<string, string> = { succeeded: '报告成功', partial: '部分完成', failed: '未成功', inconclusive: '尚无定论', conflicting: '结果存在分歧', completed: '执行结束', abandoned: '已放弃', canceled: '已取消' };
const roles: Record<string, string> = { requester: '发起者', diagnosis: '诊断', advice: '建议', review: '复核', verification: '验证', patch: '补丁', context: '背景补充', 'context-addition': '背景补充', 'tool-introduction': '工具介入', takeover: '接管', 'main-responsible': '主要负责人' };
function Fields({ value }: { value: any }) {
  return <>{[['strategy', '处理方式'], ['description', '具体介入'], ['observedEffect', '观察到的影响'], ['summary', '结果说明'], ['failureReason', '未成功原因'], ['inputScopeSummary', '处理范围'], ['limitations', '限制']].map(([key, label]) => typeof value[key] === 'string' && value[key] && <p key={key}><strong>{label}：</strong>{value[key]}</p>)}
    {value.environment && <p>环境：{value.environment.name} {value.environment.version}</p>}
    {(value.reportedOutcome || value.outcome || value.status) && <p>记录状态：{outcomes[value.reportedOutcome ?? value.outcome ?? value.status] ?? value.status}</p>}
  </>;
}
export function FactDetails({ item }: { item: any }) {
  return <div className="fact-details"><p className="muted">参与角色：{item.subjectRoles?.map((role: string) => roles[role] ?? role).join('、') || '以具体资料为准'}</p>
    {([['attempts', '实际尝试'], ['interventions', '各方介入'], ['results', '结果记录']] as const).map(([key, title]) => item[key]?.length > 0 && <section key={key}><h4>{title}</h4>{item[key].map((fact: any) => <article key={`${fact.id}:${fact.version}`}><p className="muted">{fact.actorId} · 版本 {fact.version}{fact.supersededInVisibleHistory ? ' · 已有后续更正' : ''}{fact.types ? ' · ' + fact.types.map((role: string) => roles[role] ?? role).join('、') : ''}</p><Fields value={fact}/></article>)}</section>)}
    {item.participation?.map((participation: any) => <section key={participation.participationId}><h4>{roles[participation.role] ?? participation.role}</h4><p>{participation.agreedScope}</p>{participation.deliveries?.map((delivery: any) => <article key={delivery.deliveryId}><p>{delivery.summary}</p><p className="muted">{delivery.acceptance ? '发起者已接受此交付；是否独立验证、整体是否解决分别记录。' : '交付待发起者验收。'}</p></article>)}</section>)}
    {item.resolution && <p className="muted">整体解决状态：{item.resolution.status === 'unrecorded' ? '尚未记录' : item.resolution.status}。是否成立以对应范围与当前可见来源为准。</p>}
  </div>;
}
