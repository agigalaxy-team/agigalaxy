import type {AdminViewServerProps} from 'payload';
import {OperationsPage,operationsPageContext,operationsSearch} from './OperationsPage';
import {Files} from './Files';
import {uuidPattern} from './operations-task-types';
export async function FilesView(props:AdminViewServerProps){
  const {session,searchParams}=await operationsPageContext(props,'/admin/operations/files'),text=(key:string)=>operationsSearch(searchParams,key);
  const id=text('id'),kind=text('kind'),state=text('state'),processing=text('processing');
  return <OperationsPage page={props}><Files key={session.operator.id+':'+id} selected={uuidPattern.test(id)?id:''} kind={['chat','forum'].includes(kind)?kind:''} state={['prepared','uploading','scan-pending','scanning','available','blocked','erased','expired','revoked'].includes(state)?state:''} processing={['scan','cleanup'].includes(processing)?processing:''} after={text('after')} csrfToken={session.csrfToken} canManage={session.operator.role==='administrator'}/></OperationsPage>;
}
