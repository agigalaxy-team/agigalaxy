import type {ReactNode} from 'react';
import type {AdminViewServerProps} from 'payload';
import {DefaultTemplate} from '@payloadcms/next/templates';
import {headers} from 'next/headers';
import {redirect} from 'next/navigation';
import {isOperator,operatorBusinessAuthorization} from '../lib/access';
import {readOperatorSession} from '../lib/operations.mjs';
import {AdminSectionTabs} from './AdminSectionTabs';
import {OperationsPageAccessProvider} from './OperationsPageAccess';

export async function operationsPageContext(props:AdminViewServerProps,path:string){
  const req=props.initPageResult.req;
  if(!isOperator(req.user))redirect('/admin/login?redirect='+encodeURIComponent(path));
  const requestHeaders=await headers(),session=await readOperatorSession(requestHeaders);
  if(session.state!=='signed-in'||session.operator.id!==req.user.externalId)redirect('/admin/login?redirect='+encodeURIComponent(path));
  return {session,requestHeaders,searchParams:props.searchParams??{}};
}
export function OperationsContent({children,variant='page'}:{children:ReactNode;variant?:'page'|'workbench'|'accounts'}){
  return <main id="galaxy-admin-main" tabIndex={-1} className={'galaxy-operations galaxy-operations--'+variant}><AdminSectionTabs/>{children}</main>;
}
export function OperationsPage({page,children,variant='page'}:{page:AdminViewServerProps;children:ReactNode;variant?:'page'|'workbench'|'accounts'}){
  const {initPageResult,params,user}=page,req=initPageResult.req;
  return <DefaultTemplate i18n={req.i18n} locale={initPageResult.locale} params={params} payload={req.payload} permissions={initPageResult.permissions} searchParams={page.searchParams??{}} user={user} visibleEntities={initPageResult.visibleEntities}><OperationsPageAccessProvider permissions={operatorBusinessAuthorization(req.user)?.permissions??[]}><OperationsContent variant={variant}>{children}</OperationsContent></OperationsPageAccessProvider></DefaultTemplate>;
}
export function operationsSearch(search:AdminViewServerProps['searchParams'],key:string){
  const value=search?.[key];return typeof value==='string'?value:'';
}
