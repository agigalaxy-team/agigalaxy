import type {AdminViewServerProps} from 'payload';
import {hasOperatorPermission} from '../lib/access';
import {aiRunsLocation,aiRunsSearchKeys} from "../lib/autonomy/ai-runs-view-model";
import {AiRuns} from './BusinessViewClients';
import {OperationsPage,operationsPageContext,operationsSearch} from './OperationsPage';
import {OperationsPermissionNotice} from './OperationsPermissionNotice';

export async function AiRunsView(props:AdminViewServerProps){
 const {session,searchParams}=await operationsPageContext(props,'/admin/operations/ai-runs');
 const canReadTasks=hasOperatorPermission(session.operator,'autonomy.read'),canReadNative=hasOperatorPermission(session.operator,'audit.read');
 if(!canReadTasks&&!canReadNative)return <OperationsPage page={props}><OperationsPermissionNotice permission="autonomy.read"/></OperationsPage>;
 const location=aiRunsLocation(Object.fromEntries(aiRunsSearchKeys.map(key=>[key,operationsSearch(searchParams,key)])));
 return <OperationsPage page={props}><AiRuns key={session.operator.id} location={location} csrfToken={session.csrfToken} canReadTasks={canReadTasks} canReadNative={canReadNative}/></OperationsPage>;
}
