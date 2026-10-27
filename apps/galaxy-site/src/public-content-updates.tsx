"use client";
import {useContext,useEffect,useRef} from 'react';
import {QueryClientContext,useQuery} from '@tanstack/react-query';
import {useRouter} from 'next/navigation';
import {useOptionalGalaxySession} from '../../../packages/galaxy-web/src/application/galaxy-session';
import {galaxyQueryKey} from '../../../packages/galaxy-web/src/shared/runtime/query-client';

/** One metadata read after a publication event, not a timer or another stream. */
function ActiveUpdates({publicationId}:{publicationId:string|null}){
 const session=useOptionalGalaxySession(),router=useRouter(),lastApplied=useRef(publicationId);
 const scope={endpoint:session?.endpoint??'',identity:'anonymous',surface:'web' as const};
 const state=useQuery({queryKey:galaxyQueryKey(scope,'site-content','publication'),enabled:!!session?.endpoint,
  initialData:{version:1,publicationId},queryFn:async({signal})=>{
   const response=await fetch('/site-publication.json',{signal,cache:'no-store'});if(!response.ok)throw Error('Publication metadata unavailable');
   const value=await response.json();if(value?.version!==1||value.publicationId!==null&&!/^[0-9a-f-]{36}$/i.test(value.publicationId??''))throw Error('Invalid publication metadata');
   return value as {version:1;publicationId:string|null};
  }});
 useEffect(()=>{if(!state.isFetchedAfterMount||state.data.publicationId===publicationId||state.data.publicationId===lastApplied.current)return;
  lastApplied.current=state.data.publicationId;router.refresh();
 },[state.isFetchedAfterMount,state.data,publicationId,router]);
 return null;
}
export function PublicContentUpdates(props:{publicationId:string|null}){
 const client=useContext(QueryClientContext);return client?<ActiveUpdates {...props}/>:null;
}
