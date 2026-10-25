import {useEffect,useMemo} from 'react';
import {createDiscoveryClient,discoveryPageKey} from './client.mjs';

export function useDiscoveryUsage({endpoint,path,search}:{endpoint?:string;path:string;search:string}){
 const client=useMemo(()=>endpoint?createDiscoveryClient({endpoint,websiteOrigin:location.origin}):null,[endpoint]);
 const pageKey=discoveryPageKey(path,search);
 useEffect(()=>{
  if(!client||!pageKey)return;
  const controller=new AbortController();
  void client.record({name:'pageview',pageKey},{signal:controller.signal}).catch(()=>{/* Usage collection never blocks reading or pretends acceptance. */});
  return()=>controller.abort();
 },[client,path,pageKey]);
}
