import type {AdminViewServerProps} from 'payload';
import {hasOperatorPermission} from '../lib/access';
import {messagingLocation,messagingSearchKeys} from '../lib/messaging-view-model';
import {Messaging} from './BusinessViewClients';
import {OperationsPage,operationsPageContext,operationsSearch} from './OperationsPage';
import {OperationsPermissionNotice} from './OperationsPermissionNotice';

export async function MessagingView(props:AdminViewServerProps){
 const {session,searchParams}=await operationsPageContext(props,'/admin/operations/messaging');
 if(!hasOperatorPermission(session.operator,'notices.read'))return <OperationsPage page={props}><OperationsPermissionNotice permission="notices.read"/></OperationsPage>;
 const can=(code:string)=>hasOperatorPermission(session.operator,code);
 const location=messagingLocation(Object.fromEntries(messagingSearchKeys.map(key=>[key,operationsSearch(searchParams,key)])));
 return <OperationsPage page={props}><Messaging key={session.operator.id} location={location} csrfToken={session.csrfToken} capabilities={{canCreate:can('notices.create'),canUpdate:can('notices.update'),canPublish:can('notices.publish'),canWithdraw:can('notices.withdraw'),canReadIdentity:can('accounts.identity.read')}}/></OperationsPage>;
}
