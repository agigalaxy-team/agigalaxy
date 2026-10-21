import type {AdminViewServerProps} from 'payload';
import {OperationsPage,operationsPageContext,operationsSearch} from './OperationsPage';
import {Community} from './Community';
import {uuidPattern} from './operations-task-types';
export async function CommunityView(props:AdminViewServerProps){
  const {session,searchParams}=await operationsPageContext(props,'/admin/operations/community'),text=(key:string)=>operationsSearch(searchParams,key),id=text('id'),after=text('after');
  const tab=text('tab')==='reports'?'reports':text('tab')==='posts'?'posts':'sections';
  const state=(tab==='reports'?['pending','appealed','resolved','withdrawn']:tab==='sections'?['active','archived']:[]).includes(text('state'))?text('state'):'';
  const category=['technology','arts','learning','life','galaxy','unclassified'].includes(text('category'))?text('category'):'';
  return <OperationsPage page={props}><Community key={session.operator.id+':'+tab+':'+id} tab={tab} selected={uuidPattern.test(id)?id:''} after={uuidPattern.test(after)?after:''} state={state} category={category} csrfToken={session.csrfToken} canManage={session.operator.role==='administrator'}/></OperationsPage>;
}
