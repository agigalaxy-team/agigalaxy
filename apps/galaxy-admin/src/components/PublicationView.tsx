import {operatorLoginPage} from '../lib/operator-login-target.mjs';
import type {AdminViewServerProps} from 'payload';
import {headers} from 'next/headers';
import {redirect} from 'next/navigation';
import {hasOperatorPermission,isOperator} from '../lib/access';
import {exportPublishedSite} from '../lib/cms';
import {operationsRead,readOperatorSession} from '../lib/operations.mjs';
import {SitePublication} from './BusinessViewClients';
import {OperationsPage} from './OperationsPage';
import {OperationsPermissionNotice} from './OperationsPermissionNotice';
import type {PublicationPage,SnapshotSummary} from "./site-publication/publication-types";
export async function PublicationView(props:AdminViewServerProps){
  const {initPageResult}=props,req=initPageResult.req,searchParams=props.searchParams??{};
  if(!isOperator(req.user))redirect(operatorLoginPage('/admin/site-publication',searchParams));
  const requestHeaders=await headers(),session=await readOperatorSession(requestHeaders);
  if(session.state!=='signed-in'||session.operator.id!==req.user.externalId)redirect(operatorLoginPage('/admin/site-publication',searchParams));
  if(!hasOperatorPermission(session.operator,'cms.read'))return <OperationsPage page={props}><OperationsPermissionNotice permission="cms.read"/></OperationsPage>;
  let summary:SnapshotSummary|null=null,snapshotError='',listError='',publications:PublicationPage={items:[],nextAfter:null};
  await Promise.all([
    exportPublishedSite({payload:req.payload,user:req.user}).then(snapshot=>{summary={siteTitle:snapshot.settings.siteTitle,pages:snapshot.pages.map((page:{id:string;path:string;title:string;updatedAt:string})=>({id:page.id,path:page.path,title:page.title,updatedAt:page.updatedAt}))};}).catch(()=>{snapshotError='请先将站点设置和需要上线的页面保存为发布版本。';}),
    operationsRead(requestHeaders,'/v1/operations/content/publications?'+new URLSearchParams({limit:'20',...(typeof searchParams.after==='string'?{after:searchParams.after}:{})})).then(value=>{publications=value;}).catch(()=>{listError='发布记录暂时无法取得。';}),
  ]);
  return <OperationsPage page={props}><SitePublication summary={summary} snapshotError={snapshotError} publications={publications} listError={listError} csrfToken={session.csrfToken} canPublish={hasOperatorPermission(session.operator,'cms.publish')}/></OperationsPage>;
}
