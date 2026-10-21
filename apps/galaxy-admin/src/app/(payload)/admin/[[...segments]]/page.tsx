import type {Metadata} from 'next';
import config from '@payload-config';
import {RootPage,generatePageMetadata} from '@payloadcms/next/views';
import {importMap} from '../importMap';
import {redirect} from 'next/navigation';
type Args={params:Promise<{segments:string[]}>;searchParams:Promise<{[key:string]:string|string[]}>};
export const dynamic='force-dynamic';
export const generateMetadata=({params,searchParams}:Args):Promise<Metadata>=>generatePageMetadata({config,params,searchParams});
export default async function Page({params,searchParams}:Args){
  const route=await params;
  if(['create-first-user','forgot','reset','verify','logout','logout-inactivity'].includes(route.segments?.[0]??''))redirect('/admin/login');
  return RootPage({config,params:Promise.resolve(route),searchParams,importMap});
}
