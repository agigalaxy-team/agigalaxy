import type {ReactNode} from 'react';
import type {AdminViewServerProps} from 'payload';
import {DefaultTemplate} from '@payloadcms/next/templates';
import {Gutter} from '@payloadcms/ui';
import {headers} from 'next/headers';
import {redirect} from 'next/navigation';
import {isOperator} from '../lib/access';
import {readOperatorSession} from '../lib/operations.mjs';

export async function operationsPageContext(props:AdminViewServerProps,path:string){
  const req=props.initPageResult.req;
  if(!isOperator(req.user))redirect('/admin/login?redirect='+encodeURIComponent(path));
  const requestHeaders=await headers(),session=await readOperatorSession(requestHeaders);
  if(session.state!=='signed-in'||session.operator.id!==req.user.externalId)redirect('/admin/login?redirect='+encodeURIComponent(path));
  return {session,requestHeaders,searchParams:props.searchParams??{}};
}
export function OperationsPage({page,children}:{page:AdminViewServerProps;children:ReactNode}){
  const {initPageResult,params,user}=page,req=initPageResult.req;
  return <DefaultTemplate i18n={req.i18n} locale={initPageResult.locale} params={params} payload={req.payload} permissions={initPageResult.permissions} searchParams={page.searchParams??{}} user={user} visibleEntities={initPageResult.visibleEntities}><Gutter>{children}</Gutter></DefaultTemplate>;
}
export function operationsSearch(search:AdminViewServerProps['searchParams'],key:string){
  const value=search?.[key];return typeof value==='string'?value:'';
}
