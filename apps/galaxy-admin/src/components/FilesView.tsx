import type {AdminViewServerProps} from 'payload';
import {OperationsPage,operationsPageContext,operationsSearch} from './OperationsPage';
import {filesLocation} from "../lib/files/files-view-model";
import {Files} from './BusinessViewClients';
import {hasOperatorPermission} from '../lib/access';
import {OperationsPermissionNotice} from './OperationsPermissionNotice';

export async function FilesView(props:AdminViewServerProps){
 const {session,searchParams}=await operationsPageContext(props,'/admin/operations/files');
 if(!hasOperatorPermission(session.operator,'files.read'))return <OperationsPage page={props}><OperationsPermissionNotice permission="files.read"/></OperationsPage>;
 const input=Object.fromEntries(['id','fileKind','kind','state','processing','issue','after','trail','view','plan'].map(key=>[key,operationsSearch(searchParams,key)]));
 return <OperationsPage page={props}><Files key={session.operator.id} location={filesLocation(input)} csrfToken={session.csrfToken} canManage={hasOperatorPermission(session.operator,'files.scan.retry')}/></OperationsPage>;
}
