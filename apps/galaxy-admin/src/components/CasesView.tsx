import type {AdminViewServerProps} from 'payload';
import {OperationsPage,operationsPageContext,operationsSearch} from './OperationsPage';
import {Cases} from './BusinessViewClients';
import {normalizeCaseFilters} from "./content-governance/cases-types";
import {hasOperatorPermission} from '../lib/access';
import {OperationsPermissionNotice} from './OperationsPermissionNotice';

export async function CasesView(props:AdminViewServerProps){
 const {session,searchParams}=await operationsPageContext(props,'/admin/operations/community?tab=reports'),text=(key:string)=>operationsSearch(searchParams,key);
 if(!hasOperatorPermission(session.operator,'cases.read'))return <OperationsPage page={props}><OperationsPermissionNotice permission="cases.read"/></OperationsPage>;
 const filters=normalizeCaseFilters({selected:text('id'),state:text('state'),after:text('after'),trail:text('trail'),query:text('q'),kind:text('kind'),view:text('view')});
 return <OperationsPage page={props}><Cases key={session.operator.id} filters={filters} csrfToken={session.csrfToken} canManage={hasOperatorPermission(session.operator,'cases.resolve')}/></OperationsPage>;
}
