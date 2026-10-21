import type {AdminViewServerProps} from 'payload';
import {DefaultTemplate} from '@payloadcms/next/templates';
import {Gutter} from '@payloadcms/ui';
import {headers} from 'next/headers';
import {redirect} from 'next/navigation';
import {isOperator} from '../lib/access';
import {exportPublishedSite} from '../lib/cms';
import {operationsRead,readOperatorSession} from '../lib/operations.mjs';
import {SitePublication} from './SitePublication';
import type {PublicationPage,SnapshotSummary} from './publication-types';
export async function PublicationView(props:AdminViewServerProps){
  const {initPageResult,params,user}=props,req=initPageResult.req,searchParams=props.searchParams??{};
  if(!isOperator(req.user))redirect('/admin/login?redirect='+encodeURIComponent('/admin/site-publication'));
  const requestHeaders=await headers(),session=await readOperatorSession(requestHeaders);
  if(session.state!=='signed-in'||session.operator.id!==req.user.externalId)redirect('/admin/login');
  let summary:SnapshotSummary|null=null,snapshotError='',listError='',publications:PublicationPage={items:[],nextAfter:null};
  await Promise.all([
    exportPublishedSite({payload:req.payload,user:req.user}).then(snapshot=>{summary={siteTitle:snapshot.settings.siteTitle,pages:snapshot.pages.map((page:{id:string;path:string;title:string;updatedAt:string})=>({id:page.id,path:page.path,title:page.title,updatedAt:page.updatedAt}))};}).catch(()=>{snapshotError='请先将站点设置和需要上线的页面保存为发布版本。';}),
    operationsRead(requestHeaders,'/v1/operations/content/publications?'+new URLSearchParams({limit:'20',...(typeof searchParams.after==='string'?{after:searchParams.after}:{})})).then(value=>{publications=value;}).catch(()=>{listError='发布记录暂时无法取得。';}),
  ]);
  return <DefaultTemplate i18n={req.i18n} locale={initPageResult.locale} params={params} payload={req.payload} permissions={initPageResult.permissions} searchParams={searchParams} user={user} visibleEntities={initPageResult.visibleEntities}><Gutter><SitePublication summary={summary} snapshotError={snapshotError} publications={publications} listError={listError} csrfToken={session.csrfToken} canPublish={session.operator.role==='administrator'}/></Gutter></DefaultTemplate>;
}
