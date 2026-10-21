import type {AdminViewServerProps} from 'payload';
import {Gutter} from '@payloadcms/ui';
import {operationsRead} from '../lib/operations.mjs';
import {operationsPageContext} from './OperationsPage';
import {OperationsDashboard} from './OperationsDashboard';
import type {OperationsSummary} from './OperationsDashboard';
export async function Welcome(props:AdminViewServerProps){
  const {requestHeaders}=await operationsPageContext(props,'/admin');
  let initial:OperationsSummary|null=null,error='';
  try{initial=await operationsRead(requestHeaders,'/v1/operations/summary');}catch{error='待处理事项暂时无法取得。';}
  return <Gutter><OperationsDashboard initial={initial} initialError={error}/></Gutter>;
}
