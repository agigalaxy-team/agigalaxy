import type {AdminViewServerProps} from 'payload';
import {hasOperatorPermission} from '../lib/access';
import {searchQualityLocation,searchQualitySearchKeys} from "../lib/search/search-quality-view-model";
import {OperationsPage,operationsPageContext,operationsSearch} from './OperationsPage';
import {OperationsPermissionNotice} from './OperationsPermissionNotice';
import {SearchQuality} from './BusinessViewClients';

export async function SearchQualityView(props:AdminViewServerProps){
 const {session,searchParams}=await operationsPageContext(props,'/admin/operations/search-quality');
 if(!hasOperatorPermission(session.operator,'search-quality.read'))return <OperationsPage page={props}><OperationsPermissionNotice permission="search-quality.read"/></OperationsPage>;
 const location=searchQualityLocation(Object.fromEntries(searchQualitySearchKeys.map(key=>[key,operationsSearch(searchParams,key)])));
 return <OperationsPage page={props}><SearchQuality key={session.operator.id} location={location} csrfToken={session.csrfToken}/></OperationsPage>;
}
