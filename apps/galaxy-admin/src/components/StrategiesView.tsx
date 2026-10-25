import type {AdminViewServerProps} from 'payload';
import {hasOperatorPermission} from '../lib/access';
import {strategiesLocation,strategiesSearchKeys} from '../lib/strategies-view-model';
import {OperationsPage,operationsPageContext,operationsSearch} from './OperationsPage';
import {OperationsPermissionNotice} from './OperationsPermissionNotice';
import {Strategies} from './BusinessViewClients';

export async function StrategiesView(props:AdminViewServerProps){
 const {session,searchParams}=await operationsPageContext(props,'/admin/operations/strategy');
 if(!hasOperatorPermission(session.operator,'strategies.read'))return <OperationsPage page={props}><OperationsPermissionNotice permission="strategies.read"/></OperationsPage>;
 const location=strategiesLocation(Object.fromEntries(strategiesSearchKeys.map(key=>[key,operationsSearch(searchParams,key)])));
 return <OperationsPage page={props}><Strategies key={session.operator.id} location={location} csrfToken={session.csrfToken}/></OperationsPage>;
}
