'use client';

import {useState} from 'react';
import Link from 'next/link';
import {ReadStatus} from '../OperationControls';
import {AutonomyTaskControls} from '../autonomy/AutonomyTaskControls';
import type {AutonomyTasksPage} from '../autonomy/autonomy-types';
import {WorkbenchActionCards} from '../workbench/WorkbenchActionCards';
import {autonomyAccountHref,autonomyBase,autonomyTaskHref,autonomyTaskTitle} from '../../lib/autonomy/autonomy-view-model';
import {communityParameterKind} from '../../lib/community-parameters';
import {useOperationsRead} from '../../lib/use-operations-read';
import {agentOsCanUseDomain,agentOsConversationPath,type AgentOsSession} from '../../lib/workbench/agentos-client';
import type {WorkbenchCards} from '../../lib/workbench/use-workbench-conversation-data';
import {useWorkbenchCommand} from '../../lib/workbench/use-workbench-command';
import {workbenchActionCards,workbenchCardPath,type WorkbenchActionCard} from '../../lib/workbench/workbench-action-cards';
import '../workbench/workbench.css';
import './community-macro.css';

const domain='governance';

function WorkbenchProposals({operatorId}:{operatorId:string}){
  const session=useOperationsRead<AgentOsSession>({path:'/v1/operations/session',failureMessage:'工作台连接暂时不可用。',clearOnOffline:true});
  const identity=session.available&&session.value?.state==='signed-in'&&session.value.operator.id===operatorId?session.value:null;
  const allowed=agentOsCanUseDomain(identity,domain);
  const cards=useOperationsRead<WorkbenchCards>({path:allowed?agentOsConversationPath(domain)+'/cards?'+new URLSearchParams({kind:communityParameterKind}):null,failureMessage:'工作台提案暂时无法读取。'});
  const proposals=workbenchActionCards(cards.value?.items,domain).filter(card=>card.kind===communityParameterKind);
  const refresh=()=>{void cards.refresh();};
  const denied=()=>{cards.clear();session.clear();void session.read();};
  const options={
    operatorId,csrfToken:identity?.csrfToken??'',canWrite:allowed,domain,permittedDomains:allowed?[domain]:[],
    async currentToken(){
      const current=await session.read();
      return current?.state==='signed-in'&&current.operator.id===operatorId&&agentOsCanUseDomain(current,domain)?current.csrfToken:null;
    },
    onCommitted:refresh,onProgress:refresh,onConflict:refresh,onDenied:denied,
  } satisfies Parameters<typeof useWorkbenchCommand>[0];
  const confirm=useWorkbenchCommand(options);
  const dismiss=useWorkbenchCommand({...options,memoryLane:'card-dismissal'});
  function decide(card:WorkbenchActionCard,accept:boolean){
    if(!cards.verified||confirm.locked||dismiss.locked||(!card.stored&&card.readExpiresAt<=Date.now()/1000))return;
    if(accept?!card.capability.canConfirm:!card.capability.canDismiss)return;
    const path=workbenchCardPath(domain,card.cardId),command=accept?confirm:dismiss;
    void command.submit(path+(accept?'/confirm':'/dismiss'),{cardId:card.cardId},'',()=>path,card.operationId);
  }
  return <section className="community-macro-panel">
    <header><h2>工作台提案</h2>{allowed&&<Link href="/admin?workbench=governance" prefetch={false}>到工作台交办</Link>}</header>
    <ReadStatus loading={session.loading||cards.loading} error={session.error||cards.error} retry={allowed?cards.read:session.read}/>
    {allowed&&cards.value&&!proposals.length&&<p>暂无提案。</p>}
    {!allowed&&identity&&<p>当前无治理工作台权限。</p>}
    <div className="galaxy-workbench community-macro-cards">
      <WorkbenchActionCards
        cards={proposals} available={cards.available} verified={cards.verified}
        busy={confirm.locked||dismiss.locked} dismissBusy={dismiss.locked}
        pendingCardId={typeof confirm.pending?.body.cardId==='string'?confirm.pending.body.cardId:null}
        now={Date.now()/1000} onConfirm={card=>decide(card,true)} onDismiss={card=>decide(card,false)}
      />
    </div>
    {(confirm.error||dismiss.error)&&<p className="galaxy-error" role="alert">{confirm.error||dismiss.error}</p>}
  </section>;
}

function AutomaticProposals({csrfToken,canConfigure}:{csrfToken:string;canConfigure:boolean}){
  const [page,setPage]=useState(1);
  const directory=useOperationsRead<AutonomyTasksPage>({
    path:autonomyBase+'/tasks?'+new URLSearchParams({domain,kind:communityParameterKind,projection:'summary',page:String(page),limit:'20'}),
    failureMessage:'自动运行提案暂时无法读取。',
  });
  const items=directory.value?.items.filter(task=>task.communityParameterProposals?.length)??[];
  return <section className="community-macro-panel">
    <header><h2>自动运行提案</h2><Link href={canConfigure?autonomyAccountHref(domain,'duty'):'/admin/operations/autonomy'} prefetch={false}>{canConfigure?'配置自动提案':'自动运行'}</Link></header>
    <ReadStatus loading={directory.loading} error={directory.error} retry={directory.read}/>
    {directory.value&&!items.length&&<p>暂无社区参数提案。</p>}
    {items.map(task=><article key={task.id} className="community-macro-task">
      <h3><Link href={autonomyTaskHref(task)} prefetch={false}>{autonomyTaskTitle(task)}</Link></h3>
      <AutonomyTaskControls task={task} csrfToken={csrfToken} onChanged={async()=>{await directory.read();}} allowActions={directory.verified} communityParametersOnly/>
    </article>)}
    {(page>1||directory.value?.nextPage)&&<div className="galaxy-operation-actions">
      <button type="button" disabled={page===1||directory.loading} onClick={()=>setPage(page-1)}>较新记录</button>
      <button type="button" disabled={!directory.value?.nextPage||directory.loading} onClick={()=>setPage(directory.value!.nextPage!)}>较早记录</button>
    </div>}
  </section>;
}

export function CommunityMacro({operatorId,csrfToken,canReadGrowth,canReadRanking,canReadWorkbench,canReadAutonomy,canConfigureAutonomy}:{operatorId:string;csrfToken:string;canReadGrowth:boolean;canReadRanking:boolean;canReadWorkbench:boolean;canReadAutonomy:boolean;canConfigureAutonomy:boolean}){
  return <section className="galaxy-business-users community-macro">
    <header><h1>宏观调控</h1></header>
    <nav className="galaxy-operation-actions" aria-label="当前生效设置">
      {canReadGrowth&&<Link href="/admin/operations/community?tab=growth" prefetch={false}>成长规则</Link>}
      {canReadRanking&&<Link href="/admin/operations/recommendation?tab=strategy" prefetch={false}>帖子评分与推荐参考</Link>}
    </nav>
    {canReadWorkbench&&<WorkbenchProposals operatorId={operatorId}/>}
    {canReadAutonomy&&<AutomaticProposals csrfToken={csrfToken} canConfigure={canConfigureAutonomy}/>}
  </section>;
}
