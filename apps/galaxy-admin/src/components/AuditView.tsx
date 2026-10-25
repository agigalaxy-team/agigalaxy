import type {AdminViewServerProps} from 'payload';
import {OperationsPage,operationsPageContext,operationsSearch} from './OperationsPage';
import {Audit} from './BusinessViewClients';
import {normalizeAuditFilters} from '../lib/audit-view-model';
import {hasOperatorPermission} from '../lib/access';
import {OperationsPermissionNotice} from './OperationsPermissionNotice';

export async function AuditView(props:AdminViewServerProps){
  const {session,searchParams}=await operationsPageContext(props,'/admin/operations/audit');
  if(!hasOperatorPermission(session.operator,'audit.read'))return <OperationsPage page={props}><OperationsPermissionNotice permission="audit.read"/></OperationsPage>;
  const text=(key:string)=>operationsSearch(searchParams,key);
  const filters=normalizeAuditFilters({account:text('accountId'),resource:text('resource'),after:text('after'),trail:text('trail'),selected:text('id'),query:text('q'),kind:text('kind'),action:text('action'),day:text('day'),page:text('page'),pageSize:text('pageSize'),snapshot:text('snapshot'),sort:text('sort')});
  return <OperationsPage page={props}><Audit key={session.operator.id} filters={filters} positionOwner={{operatorId:session.operator.id,loginGeneration:session.csrfToken,authorizationVersion:session.operator.businessAuthorization?.version??''}}/></OperationsPage>;
}
