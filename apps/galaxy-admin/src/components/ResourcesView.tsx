import type {AdminViewServerProps} from 'payload';
import {OperationsPage,operationsPageContext,operationsSearch} from './OperationsPage';
import {Resources} from './BusinessViewClients';
import {uuidPattern} from './operations-task-types';
import {hasAnyOperatorPermission,hasOperatorPermission} from '../lib/access';
import {OperationsPermissionNotice} from './OperationsPermissionNotice';
export async function ResourcesView(props:AdminViewServerProps){
  const {session,searchParams}=await operationsPageContext(props,'/admin/operations/resources');
  if(!hasOperatorPermission(session.operator,'resources.read'))return <OperationsPage page={props}><OperationsPermissionNotice permission="resources.read"/></OperationsPage>;
  const kind=operationsSearch(searchParams,'kind')==='methods'?'methods':'projects',value=operationsSearch(searchParams,'id');
  const id=uuidPattern.test(value)?value:'',state=operationsSearch(searchParams,'state'),after=operationsSearch(searchParams,'after');
  return <OperationsPage page={props}><Resources key={session.operator.id} kind={kind} selected={id} state={kind==='projects'&&['active','archived'].includes(state)?state:''} after={uuidPattern.test(after)?after:''} csrfToken={session.csrfToken} canManage={hasAnyOperatorPermission(session.operator,['resources.hide','resources.restore'])}/></OperationsPage>;
}
