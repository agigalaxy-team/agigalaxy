import type {Metadata} from 'next';
import config from '@payload-config';
import {RootPage,generatePageMetadata} from '@payloadcms/next/views';
import {importMap} from '../importMap';
import {headers} from 'next/headers';
import {readOperatorSession} from '../../../../lib/operations.mjs';
import {OperatorSessionUnavailable} from '../../../../components/OperatorSessionUnavailable';
import {redirect} from 'next/navigation';
type Args={params:Promise<{segments:string[]}>;searchParams:Promise<{[key:string]:string|string[]}>};
export const dynamic='force-dynamic';
export const generateMetadata=async({params,searchParams}:Args):Promise<Metadata>=>{try{await readOperatorSession(await headers());}catch{return {title:'管理会话暂不可用'};}return generatePageMetadata({config,params,searchParams});};
export default async function Page({params,searchParams}:Args){
  const route=await params;
  // Keep unknown transport/auth availability out of Payload's null-user fallback.
  // This is the same request-scoped read used by the actual strategy, not cached authority.
  try{await readOperatorSession(await headers());}catch{return <OperatorSessionUnavailable/>;}
  if(['create-first-user','forgot','reset','verify','logout','logout-inactivity'].includes(route.segments?.[0]??''))redirect('/admin/login');
  return RootPage({config,params:Promise.resolve(route),searchParams,importMap});
}
