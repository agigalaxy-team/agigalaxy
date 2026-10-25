import type {AdminViewServerProps} from 'payload';
import {hasOperatorPermission,operatorBusinessAuthorization} from '../lib/access';
import {operationsRead} from '../lib/operations.mjs';
import {OperationsPage,operationsPageContext} from './OperationsPage';
import {OperationsPermissionNotice} from './OperationsPermissionNotice';
import {ManagementAccounts} from './BusinessViewClients';
import {managementAccountsBase,managementAccountsLocation,managementAccountsQuery,managementAccountsRoute} from '../lib/management-accounts-view-model';
import type {ManagementAccountDetail,ManagementAccountsPage} from './management-accounts-types';

export async function ManagementAccountsView(props:AdminViewServerProps){
  const {session,requestHeaders,searchParams}=await operationsPageContext(props,managementAccountsRoute);
  if(!hasOperatorPermission(session.operator,'management.accounts.read'))
    return <OperationsPage page={props} variant="accounts"><OperationsPermissionNotice permission="management.accounts.read"/></OperationsPage>;
  const initialLocation=managementAccountsLocation(Object.fromEntries(Object.entries(searchParams)
    .filter((entry):entry is [string,string]=>typeof entry[1]==='string')));
  let initialPage:ManagementAccountsPage|null=null,initialDetail:ManagementAccountDetail|null=null,initialError='',initialDetailError='';
  await Promise.all([
    operationsRead(requestHeaders,managementAccountsBase+'?'+managementAccountsQuery(initialLocation))
      .then((value:ManagementAccountsPage)=>{initialPage=value;}).catch(()=>{initialError='管理账户目录暂时无法读取。';}),
    !initialLocation.creating&&initialLocation.operator
      ?operationsRead(requestHeaders,managementAccountsBase+'/'+initialLocation.operator)
        .then((value:ManagementAccountDetail)=>{initialDetail=value;}).catch(()=>{initialDetailError='当前管理账户暂时无法读取。';})
      :Promise.resolve(),
  ]);
  return <OperationsPage page={props} variant="accounts"><ManagementAccounts key={session.operator.id}
    operatorId={session.operator.id} csrfToken={session.csrfToken} businessAuthorization={operatorBusinessAuthorization(session.operator)??null}
    initialLocation={initialLocation} initialPage={initialPage} initialDetail={initialDetail}
    initialError={initialError} initialDetailError={initialDetailError}/></OperationsPage>;
}
