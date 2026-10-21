import type {AdminViewServerProps} from 'payload';
import {OperationsPage,operationsPageContext,operationsSearch} from './OperationsPage';
import {Rules} from './Rules';
export async function RulesView(props:AdminViewServerProps){
  const {session,searchParams}=await operationsPageContext(props,'/admin/operations/rules'),key=operationsSearch(searchParams,'key');
  return <OperationsPage page={props}><Rules key={session.operator.id+':'+key} selected={key==='community-quota'||key==='forum-quota'?key:'resource-budget'} csrfToken={session.csrfToken} canManage={session.operator.role==='administrator'}/></OperationsPage>;
}
