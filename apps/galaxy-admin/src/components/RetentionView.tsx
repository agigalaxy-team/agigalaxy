import type {AdminViewServerProps} from 'payload';
import {OperationsPage,operationsPageContext,operationsSearch} from './OperationsPage';
import {Retention} from './Retention';
import {uuidPattern} from './operations-task-types';
export async function RetentionView(props:AdminViewServerProps){
  const {session,searchParams}=await operationsPageContext(props,'/admin/operations/retention'),id=operationsSearch(searchParams,'run'),after=operationsSearch(searchParams,'after');
  return <OperationsPage page={props}><Retention key={session.operator.id} selected={uuidPattern.test(id)?id:''} after={/^[1-9][0-9]{0,18}$/.test(after)?after:''} csrfToken={session.csrfToken} canManage={session.operator.role==='administrator'}/></OperationsPage>;
}
