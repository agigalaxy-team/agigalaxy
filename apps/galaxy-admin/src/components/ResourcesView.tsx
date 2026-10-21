import type {AdminViewServerProps} from 'payload';
import {OperationsPage,operationsPageContext,operationsSearch} from './OperationsPage';
import {Resources} from './Resources';
import {uuidPattern} from './operations-task-types';
export async function ResourcesView(props:AdminViewServerProps){
  const {session,searchParams}=await operationsPageContext(props,'/admin/operations/resources');
  const kind=operationsSearch(searchParams,'kind')==='methods'?'methods':'projects',value=operationsSearch(searchParams,'id');
  const id=uuidPattern.test(value)?value:'',state=operationsSearch(searchParams,'state'),after=operationsSearch(searchParams,'after');
  return <OperationsPage page={props}><Resources key={session.operator.id+':'+kind+':'+id} kind={kind} selected={id} state={kind==='projects'&&['active','archived'].includes(state)?state:''} after={uuidPattern.test(after)?after:''} csrfToken={session.csrfToken} canManage={session.operator.role==='administrator'}/></OperationsPage>;
}
