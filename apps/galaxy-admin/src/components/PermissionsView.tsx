import type {AdminViewServerProps} from 'payload';
import {OperationsPage,operationsPageContext,operationsSearch} from './OperationsPage';
import {permissionsLocation} from '../lib/permissions-view-model';
import type {BusinessAuthorization} from './permissions-types';
import {Permissions} from './BusinessViewClients';

export async function PermissionsView(props:AdminViewServerProps){
 const {session,searchParams}=await operationsPageContext(props,'/admin/operations/permissions');
 const input=Object.fromEntries(['tab','id','role','after','trail','aiAccount'].map(key=>[key,operationsSearch(searchParams,key)]));
 const operator=session.operator as typeof session.operator&{businessAuthorization?:BusinessAuthorization};
 return <OperationsPage page={props}><Permissions key={operator.id} operatorId={operator.id} location={permissionsLocation(input)} csrfToken={session.csrfToken} authorization={operator.businessAuthorization??null}/></OperationsPage>;
}
