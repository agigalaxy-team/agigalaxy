'use client';

import {useCallback,useLayoutEffect,useState} from 'react';
import {useOperationsRead} from '../../lib/use-operations-read';
import type {OperationsSummary} from '../../lib/admin-analytics-types';
import {workbenchInventory,workbenchJobState,workbenchPending,workbenchRecords,workbenchTime} from '../../lib/workbench-view-model';
import {AdminIcon} from '../AdminIcons';
import {WorkbenchAnalytics} from './WorkbenchAnalytics';
import {WorkbenchCommunication} from './WorkbenchCommunication';
import {WorkbenchOperationsLog} from './WorkbenchOperationsLog';
import {WorkbenchPendingList,WorkbenchProgress,WorkbenchShortcuts} from './WorkbenchSidebar';
import {AutonomySummary} from '../AutonomyShared';
import {autonomyTaskHref,autonomyTaskTitle} from '../../lib/autonomy-view-model';
import './workbench.css';
import {WorkbenchInteractionProvider} from './WorkbenchInteraction';

export type {OperationsSummary} from '../../lib/admin-analytics-types';

export function OperationsDashboard({initial,initialError}:{initial:OperationsSummary|null;initialError:string}){
  const page=useOperationsRead<OperationsSummary>({path:'/v1/operations/summary?publicActivity=deferred',initial,initialError,failureMessage:'工作台数据暂时无法取得。',clearOnOffline:true});
  const [communicationFocused,setCommunicationFocused]=useState(false);
  const [refreshKey,setRefreshKey]=useState(0);
  // A missing business snapshot is not a change of management identity.
  const [communicationOperatorId,setCommunicationOperatorId]=useState(initial?.operator?.id??null),[signedOut,setSignedOut]=useState(false);
  useLayoutEffect(()=>{if(page.verified&&page.value?.operator?.id){setCommunicationOperatorId(page.value.operator.id);setSignedOut(false);}},[page.verified,page.value?.operator?.id]);
  const identityChanged=useCallback((operatorId:string|null)=>{setCommunicationOperatorId(operatorId);setSignedOut(operatorId===null);page.clear();if(operatorId)void page.read();},[page.clear,page.read]);
  const value=page.value,records=workbenchRecords(value),jobs=workbenchJobState(value);
  const pendingScopes=['communityReports','chatReports','files','jobs','search','feedback'] as const;
  const pendingDenied=!!value&&pendingScopes.every(key=>value.availability?.[key]==='not-authorized');
  const pendingRestricted=!!value&&pendingScopes.some(key=>value.availability?.[key]==='not-authorized');
  const authorization=value?.operator?.businessAuthorization;
  const autonomyAccess=page.verified&&authorization?.permissions.includes('autonomy.read');
  const auto=page.verified?value?.autonomy??null:null;
  const pending=workbenchPending(value);
  if(auto?.summary.waitingHuman&&auto.summary.waitingHuman>0)pending.push({id:'autonomy-human',group:'system',label:'自动流程等待决定',count:auto.summary.waitingHuman,unit:'项待决定',href:'/admin/operations/ai-runs?state=awaiting-human',icon:'strategy'});
  const progress=(auto?.recentTasks??[]).filter(task=>['running','queued'].includes(task.state)).map(task=>({id:task.id,label:autonomyTaskTitle(task),createdAt:task.updatedAt,href:autonomyTaskHref(task),source:'自动运行'}));
  const analyticsAccess=!value?'unverified':authorization?.version&&authorization.permissions.includes('analytics.read')?'authorized':'denied';
  const publicAccess=!value?'unverified':value.availability.businessActivity==='not-authorized'||!authorization?.permissions.includes('content.read')?'denied':'authorized';
  const connection=page.loading&&!value?'loading':value?.ai?.state==='connected'?'connected':value?.ai?.state==='not-connected'?'not-connected':'unavailable';
  return <section className={'galaxy-workbench'+(communicationFocused?' galaxy-workbench--communicating':'')} aria-label="运营工作台" aria-busy={!page.ready||page.loading} inert={!page.ready}>
    {page.error&&<div className="wb-read-error" role="alert"><span>{page.error}</span><button type="button" className="wb-text-button" disabled={page.loading} onClick={()=>void page.read()}>重新读取</button></div>}
    <div className="wb-layout"><div className="wb-primary">
      <section className="wb-overview"><header className="wb-overview-heading"><div><h1>今天的运营</h1></div><div className="wb-observed-at" aria-live="polite">{page.loading?<span>正在更新…</span>:value?<span>{page.error?'上次读取 ':'更新于 '}{workbenchTime(value.checkedAt)}</span>:<span>尚未取得数据</span>}<button type="button" className="wb-icon-button" aria-label="更新工作台数据" title="更新数据" disabled={!page.ready||page.loading} onClick={()=>{setRefreshKey(key=>key+1);void page.read();}}><AdminIcon name="refresh" size={17}/></button></div></header>
        {autonomyAccess&&<AutonomySummary value={auto} loading={page.loading} error={value?.availability.ai==='unavailable'?'自动运行数据暂时无法取得。':''}/>}
        <WorkbenchAnalytics key={value?.operator?.id??'unverified'} access={analyticsAccess} publicAccess={publicAccess} operatorId={value?.operator.id??null} summaryLoading={page.loading&&!value} refreshKey={refreshKey} refreshSummary={page.read} inventory={workbenchInventory(value)}/>
      </section>
      <WorkbenchInteractionProvider key={communicationOperatorId??'signed-out'}><div className="wb-bottom"><WorkbenchOperationsLog records={records} available={Array.isArray(value?.recentOperations)} denied={value?.availability?.recentOperations==='not-authorized'} loading={page.loading} aiState={connection} aiDenied={value?.availability?.ai==='not-authorized'} aiTasks={value?.autonomy?.recentTasks??[]}/><WorkbenchCommunication connection={connection} focused={communicationFocused} onFocusChange={setCommunicationFocused} operatorId={communicationOperatorId} onIdentityChange={identityChanged} signedOut={signedOut}/></div></WorkbenchInteractionProvider>
    </div><aside className="wb-sidebar" aria-label="运营事项"><WorkbenchPendingList items={pending} available={value!==null||auto!==null} loading={page.loading} denied={pendingDenied&&!autonomyAccess} restricted={pendingRestricted}/><WorkbenchProgress records={progress} available={auto!==null} running={jobs?.running??null} waiting={jobs?.waiting??null}/><WorkbenchShortcuts key={value?.operator?.id??'unverified'} operatorId={value?.operator?.id??null}/></aside></div>
  </section>;
}
