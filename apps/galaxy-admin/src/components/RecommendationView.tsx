import type {AdminViewServerProps} from 'payload';
import {hasOperatorPermission} from '../lib/access';
import {recommendationLocation,recommendationSearchKeys} from "../lib/recommendation/recommendation-view-model";
import {Recommendation} from './BusinessViewClients';
import {OperationsPage,operationsPageContext,operationsSearch} from './OperationsPage';
import {OperationsPermissionNotice} from './OperationsPermissionNotice';

export async function RecommendationView(props:AdminViewServerProps){
 const {session,searchParams}=await operationsPageContext(props,'/admin/operations/recommendation');
 if(!hasOperatorPermission(session.operator,'recommendations.read'))return <OperationsPage page={props}><OperationsPermissionNotice permission="recommendations.read"/></OperationsPage>;
 const location=recommendationLocation(Object.fromEntries(recommendationSearchKeys.map(key=>[key,operationsSearch(searchParams,key)])));
 return <OperationsPage page={props}><Recommendation key={session.operator.id} location={location} csrfToken={session.csrfToken}/></OperationsPage>;
}
