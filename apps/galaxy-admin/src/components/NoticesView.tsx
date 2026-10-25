import type {AdminViewServerProps} from 'payload';
import {OperationsPage,operationsPageContext,operationsSearch} from './OperationsPage';
import {Notices} from './BusinessViewClients';
import {uuidPattern} from './operations-task-types';
import {hasOperatorPermission} from '../lib/access';
import {OperationsPermissionNotice} from './OperationsPermissionNotice';
export async function NoticesView(props:AdminViewServerProps){
  const {session,searchParams}=await operationsPageContext(props,'/admin/operations/notices'),value=operationsSearch(searchParams,'notice'),after=operationsSearch(searchParams,'after');
  if(!hasOperatorPermission(session.operator,'notices.read'))return <OperationsPage page={props}><OperationsPermissionNotice permission="notices.read"/></OperationsPage>;
  return <OperationsPage page={props}><Notices key={session.operator.id} selected={uuidPattern.test(value)?value:''} creating={value==='new'} after={/^[1-9][0-9]{0,18}$/.test(after)?after:''} csrfToken={session.csrfToken} capabilities={{canCreate:hasOperatorPermission(session.operator,'notices.create'),canUpdate:hasOperatorPermission(session.operator,'notices.update'),canPublish:hasOperatorPermission(session.operator,'notices.publish'),canWithdraw:hasOperatorPermission(session.operator,'notices.withdraw'),canReadIdentity:hasOperatorPermission(session.operator,'accounts.identity.read')}}/></OperationsPage>;
}
