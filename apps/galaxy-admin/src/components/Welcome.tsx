import type {AdminViewServerProps} from 'payload';
import {operationsRead} from '../lib/operations.mjs';
import {OperationsContent,operationsPageContext} from './OperationsPage';
import {OperationsDashboard} from './BusinessViewClients';
import type {OperationsSummary} from './workbench/OperationsDashboard';
export async function Welcome(props:AdminViewServerProps){
  const {requestHeaders,session}=await operationsPageContext(props,'/admin');
  let initial:OperationsSummary|null=null,error='';
  try{initial=await operationsRead(requestHeaders,'/v1/operations/summary?publicActivity=deferred');}catch{error='待处理事项暂时无法取得。';}
  return <OperationsContent variant="workbench"><OperationsDashboard key={session.operator.id} initial={initial} initialError={error}/></OperationsContent>;
}
