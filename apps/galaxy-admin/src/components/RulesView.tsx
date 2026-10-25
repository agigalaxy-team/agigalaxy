import type {AdminViewServerProps} from 'payload';
import {OperationsPage,operationsPageContext} from './OperationsPage';
import {Rules} from './BusinessViewClients';
import {hasOperatorPermission} from '../lib/access';
import {OperationsPermissionNotice} from './OperationsPermissionNotice';
import {rulesLocation} from '../lib/rules-view-model';
export async function RulesView(props:AdminViewServerProps){
  const {session,searchParams}=await operationsPageContext(props,'/admin/operations/rules');
  if(!hasOperatorPermission(session.operator,'rules.read'))return <OperationsPage page={props}><OperationsPermissionNotice permission="rules.read"/></OperationsPage>;
  return <OperationsPage page={props}><Rules key={session.operator.id} location={rulesLocation(searchParams)} csrfToken={session.csrfToken} canManage={hasOperatorPermission(session.operator,'rules.write')} canReadAccounts={hasOperatorPermission(session.operator,'accounts.read')} canSearchEmail={hasOperatorPermission(session.operator,'accounts.identity.read')}/></OperationsPage>;
}
