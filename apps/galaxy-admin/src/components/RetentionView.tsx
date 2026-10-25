import type {AdminViewServerProps} from 'payload';
import {OperationsPage,operationsPageContext,operationsSearch} from './OperationsPage';
import {Retention} from './BusinessViewClients';
import {uuidPattern} from './operations-task-types';
import {hasOperatorPermission} from '../lib/access';
import {OperationsPermissionNotice} from './OperationsPermissionNotice';
export async function RetentionView(props:AdminViewServerProps){
  const {session,searchParams}=await operationsPageContext(props,'/admin/operations/retention'),id=operationsSearch(searchParams,'run'),after=operationsSearch(searchParams,'after');
  if(!hasOperatorPermission(session.operator,'retention.read'))return <OperationsPage page={props}><OperationsPermissionNotice permission="retention.read"/></OperationsPage>;
  return <OperationsPage page={props}><Retention key={session.operator.id} selected={uuidPattern.test(id)?id:''} after={/^[1-9][0-9]{0,18}$/.test(after)?after:''} csrfToken={session.csrfToken} canManage={hasOperatorPermission(session.operator,'retention.request')}/></OperationsPage>;
}
