import type {AdminViewServerProps} from 'payload';
import {OperationsPage,operationsPageContext,operationsSearch} from './OperationsPage';
import {Notices} from './Notices';
import {uuidPattern} from './operations-task-types';
export async function NoticesView(props:AdminViewServerProps){
  const {session,searchParams}=await operationsPageContext(props,'/admin/operations/notices'),value=operationsSearch(searchParams,'notice'),after=operationsSearch(searchParams,'after');
  return <OperationsPage page={props}><Notices key={session.operator.id} selected={uuidPattern.test(value)?value:''} creating={value==='new'} after={/^[1-9][0-9]{0,18}$/.test(after)?after:''} csrfToken={session.csrfToken} canManage={session.operator.role==='administrator'}/></OperationsPage>;
}
