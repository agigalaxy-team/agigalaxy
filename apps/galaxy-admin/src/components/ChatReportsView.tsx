import type {AdminViewServerProps} from 'payload';
import {OperationsPage,operationsPageContext,operationsSearch} from './OperationsPage';
import {ChatReports} from './BusinessViewClients';
import {normalizeChatReportFilters} from './chat-report-types';
import {hasAnyOperatorPermission,hasOperatorPermission} from '../lib/access';
import {OperationsPermissionNotice} from './OperationsPermissionNotice';

export async function ChatReportsView(props:AdminViewServerProps){
 const {session,searchParams}=await operationsPageContext(props,'/admin/operations/chat-reports');
 if(!hasOperatorPermission(session.operator,'chat-reports.read'))return <OperationsPage page={props}><OperationsPermissionNotice permission="chat-reports.read"/></OperationsPage>;
 const filters=normalizeChatReportFilters(Object.fromEntries(['report','state','room','after','trail','view'].map(key=>[key,operationsSearch(searchParams,key)])));
 return <OperationsPage page={props}><ChatReports key={session.operator.id} filters={filters} csrfToken={session.csrfToken} canManage={hasAnyOperatorPermission(session.operator,['chat-reports.moderate','chat-messages.hide','chat-messages.restore','chat-messages.keep'])}/></OperationsPage>;
}
