import {headers} from 'next/headers';
import {notFound,redirect} from 'next/navigation';
import Link from 'next/link';
import {authenticatedCMS} from '../../../../../lib/cms';
import {projectBlocks} from '../../../../../lib/content-model.mjs';
import {SiteContent,type ContentBlock,type SiteMedia} from '../../../../../components/SiteContent';
export const dynamic='force-dynamic';
export default async function PreviewPage({params}:{params:Promise<{id:string}>}){
  const {id}=await params;
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))notFound();
  const context=await authenticatedCMS(await headers());
  if(!context)redirect('/admin/login?redirect='+encodeURIComponent('/preview/pages/'+id));
  const page=await context.payload.findByID({collection:'site-pages',id,draft:true,depth:0,overrideAccess:false,user:context.user,disableErrors:true});
  if(!page)notFound();
  const ids=new Set<string>();
  if(Array.isArray(page.blocks))for(const block of page.blocks)if(block.blockType==='image'&&block.media!=null)ids.add(String(typeof block.media==='object'?block.media.id:block.media));
  const media=await Promise.all([...ids].map(id=>context.payload.findByID({collection:'media',id,depth:0,overrideAccess:false,user:context.user})));
  const projected=projectBlocks(page.blocks,media) as {blocks:ContentBlock[];media:SiteMedia[]};
  return <><div className="galaxy-preview-toolbar"><strong>页面预览</strong><span>{String(page.title)}</span><Link href={'/admin/collections/site-pages/'+encodeURIComponent(id)}>继续编辑</Link></div><SiteContent blocks={projected.blocks} media={projected.media}/></>;
}
