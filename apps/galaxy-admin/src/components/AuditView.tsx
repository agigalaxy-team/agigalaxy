import type {AdminViewServerProps} from 'payload';
import {OperationsPage,operationsPageContext,operationsSearch} from './OperationsPage';
import {Audit} from './Audit';
import {uuidPattern} from './operations-task-types';
export async function AuditView(props:AdminViewServerProps){
  const {session,searchParams}=await operationsPageContext(props,'/admin/operations/audit');
  const account=operationsSearch(searchParams,'accountId'),resource=operationsSearch(searchParams,'resource'),after=operationsSearch(searchParams,'after');
  return <OperationsPage page={props}><Audit key={session.operator.id} account={uuidPattern.test(account)?account:''} resource={uuidPattern.test(resource)?resource:''} after={/^[1-9][0-9]{0,18}$/.test(after)?after:''}/></OperationsPage>;
}
