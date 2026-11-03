'use client';

import Link from 'next/link';
import type {AutonomyAccount, AutonomyDispatch} from './autonomy-types';
import {AutonomyEmpty, AutonomyState} from './AutonomyShared';
import {autonomyDate, autonomyDomains, autonomyHealthNames, autonomyStates} from '../../lib/autonomy/autonomy-view-model';

function triggerLabel(trigger: AutonomyDispatch['trigger']) {
  switch (trigger.kind) {
    case 'interval': return `每 ${trigger.minutes} 分钟`;
    case 'daily': return `每日 ${trigger.at || ''}`;
    case 'event': return '事件触发';
    default: return '单次';
  }
}

export function AutonomyDispatches({accounts}: {accounts: AutonomyAccount[]}) {
  const items = accounts.flatMap(account => (account.dispatches ?? []).map(dispatch => ({account, dispatch})));
  return <section className="auto-panel" aria-label="工作台交办">
    <header className="auto-section-head"><h2>工作台交办</h2></header>
    {items.length ? <div className="auto-table-scroll"><table className="auto-table">
      <thead><tr><th>交办任务</th><th>岗位</th><th>运行状态</th><th>计划</th><th>最近一轮</th><th>有效巡检</th><th>下次执行</th></tr></thead>
      <tbody>{items.map(({account, dispatch}) => <tr key={dispatch.id}>
        <th>{dispatch.title}</th><td>{autonomyDomains[account.domain]}</td>
        <td><AutonomyState tone={!dispatch.enabled ? 'neutral' : ['healthy', 'running', 'ready'].includes(dispatch.health) ? 'active' : 'attention'}>{!dispatch.enabled ? '已停用' : dispatch.active===false&&dispatch.trigger.kind==='once' ? '本次已结束' : autonomyHealthNames[dispatch.health] ?? '状态未确认'}</AutonomyState></td>
        <td>{triggerLabel(dispatch.trigger)}</td>
        <td>{dispatch.latestTask ? <Link href={'/admin/operations/ai-runs?task=' + dispatch.latestTask.id} prefetch={false}>
          {autonomyStates[dispatch.latestTask.state] ?? '状态未确认'}<small>{autonomyDate(dispatch.latestTask.updatedAt)}</small>
        </Link> : '尚无可查看轮次'}</td>
        <td>{autonomyDate(dispatch.lastValidAt)}</td><td>{dispatch.enabled ? autonomyDate(dispatch.nextDueAt) : '已停用'}</td>
      </tr>)}</tbody>
    </table></div> : <AutonomyEmpty>尚无工作台交办</AutonomyEmpty>}
  </section>;
}
