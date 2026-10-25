import type {AdminViewServerProps} from 'payload';
import {hasOperatorPermission} from '../lib/access';
import {modelSettingsLocation,modelSettingsSearchKeys} from '../lib/model-settings-view-model';
import {OperationsPage,operationsPageContext,operationsSearch} from './OperationsPage';
import {OperationsPermissionNotice} from './OperationsPermissionNotice';
import {ModelSettings} from './BusinessViewClients';

export async function ModelSettingsView(props:AdminViewServerProps){
 const {session,searchParams}=await operationsPageContext(props,'/admin/operations/models');
 if(!hasOperatorPermission(session.operator,'models.read'))return <OperationsPage page={props}><OperationsPermissionNotice permission="models.read"/></OperationsPage>;
 const location=modelSettingsLocation(Object.fromEntries(modelSettingsSearchKeys.map(key=>[key,operationsSearch(searchParams,key)])));
 return <OperationsPage page={props}><ModelSettings key={session.operator.id} location={location} csrfToken={session.csrfToken} canConfigure={hasOperatorPermission(session.operator,'models.configure')} canApply={hasOperatorPermission(session.operator,'models.apply')}/></OperationsPage>;
}
