import type {AdminViewServerProps} from 'payload';
import {hasOperatorPermission} from '../lib/access';
import {analyticsLocation,analyticsSearchKeys} from '../lib/analytics-view-model';
import {Analytics} from './BusinessViewClients';
import {OperationsPage,operationsPageContext,operationsSearch} from './OperationsPage';
import {OperationsPermissionNotice} from './OperationsPermissionNotice';

export async function AnalyticsView(props:AdminViewServerProps){
 const {session,searchParams}=await operationsPageContext(props,'/admin/operations/analytics');
 if(!hasOperatorPermission(session.operator,'analytics.read'))return <OperationsPage page={props}><OperationsPermissionNotice permission="analytics.read"/></OperationsPage>;
 const location=analyticsLocation(Object.fromEntries(analyticsSearchKeys.map(key=>[key,operationsSearch(searchParams,key)])));
 return <OperationsPage page={props}><Analytics key={session.operator.id} location={location}/></OperationsPage>;
}
