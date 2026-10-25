import type {AdminViewServerProps} from 'payload';
import {redirect} from 'next/navigation';
import {OperationsPage,operationsPageContext,operationsSearch} from './OperationsPage';
import {OperationsPermissionNotice} from './OperationsPermissionNotice';
import {hasOperatorPermission} from '../lib/access';
import {maintenanceHref,maintenanceLocation} from '../lib/maintenance-view-model';
import {Maintenance} from './BusinessViewClients';

export async function MaintenanceView(props:AdminViewServerProps){
 const {session,searchParams}=await operationsPageContext(props,'/admin/operations/maintenance');
 const canRead=hasOperatorPermission(session.operator,'maintenance.read'),canReadLogs=hasOperatorPermission(session.operator,'maintenance.logs.read');
 if(!canRead&&!canReadLogs)return <OperationsPage page={props}><OperationsPermissionNotice permission="maintenance.read"/></OperationsPage>;
 const keys=['tab','point','plan','backupAfter','backupTrail','planAfter','planTrail','historyAfter','historyTrail','component','level','period','before','logTrail'];
 const location=maintenanceLocation(Object.fromEntries(keys.map(key=>[key,operationsSearch(searchParams,key)])));
 if(!canRead&&location.tab!=='logs')redirect(maintenanceHref(location,{tab:'logs'}));
 return <OperationsPage page={props}><Maintenance key={session.operator.id} location={location} csrfToken={session.csrfToken} canRead={canRead} canReadLogs={canReadLogs}/></OperationsPage>;
}
