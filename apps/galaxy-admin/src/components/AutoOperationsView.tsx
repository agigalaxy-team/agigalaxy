import type {AdminViewServerProps} from 'payload';
import {hasOperatorPermission} from '../lib/access';
import {AutoOperations} from "./autonomy/AutoOperations";
import {OperationsPage,operationsPageContext} from './OperationsPage';
import {OperationsPermissionNotice} from './OperationsPermissionNotice';

export async function AutoOperationsView(props:AdminViewServerProps){
 const {session}=await operationsPageContext(props,'/admin/operations/autonomy');
 if(!hasOperatorPermission(session.operator,'autonomy.read'))return <OperationsPage page={props}><OperationsPermissionNotice permission="autonomy.read"/></OperationsPage>;
 return <OperationsPage page={props}><AutoOperations key={session.operator.id} csrfToken={session.csrfToken} canConfigure={hasOperatorPermission(session.operator,'autonomy.configure')}/></OperationsPage>;
}
