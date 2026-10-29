'use client';
import {createContext,useContext,useEffect,useMemo,useState,useRef,useLayoutEffect,type ReactNode} from 'react';
import {QueryClientProvider} from '@tanstack/react-query';
import {useAuth} from '@payloadcms/ui';
import {createGalaxyQueryClient,galaxyQueryKey} from '../../../../packages/galaxy-web/src/shared/runtime/query-client';
import {createGalaxyEventClient} from '../../../../packages/galaxy-web/src/shared/runtime/event-stream';
import type {GalaxyWebEvent} from '../../../../packages/galaxy-web/src/shared/runtime/event-dispatcher';
import {observeUserActivity,userActivityVersion} from '../../../../packages/galaxy-web/src/shared/runtime/activity';
import {settingsOperatorId} from '../lib/settings-draft-memory';
export type AdminAgentOSChange={kind:'conversation-operation'|'conversation-card'|'conversation-context'|'conversation-tool'|'configuration';objectId?:string;parentId?:string;turnId?:string};
export type AdminAgentOSResync={reason:'replay-gap'|'unknown-change'};
const eventId=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function agentOSChange(event:GalaxyWebEvent){
 if(event.module!=='agentos')return;
 const kind=event.entity;
 if(!kind||!['conversation-operation','conversation-card','conversation-context','conversation-tool','configuration'].includes(kind)
  ||kind!=='configuration'&&(!eventId(event.objectId)||!eventId(event.parentId))
  ||(kind==='conversation-operation'||kind==='conversation-card'||kind==='conversation-tool')&&!eventId(event.turnId)){
  window.dispatchEvent(new CustomEvent<AdminAgentOSResync>('galaxy:admin-agentos-resync',{detail:{reason:'unknown-change'}}));return;
 }
 const detail:AdminAgentOSChange={kind,...(event.objectId&&eventId(event.objectId)?{objectId:event.objectId}:{}),...(event.parentId&&eventId(event.parentId)?{parentId:event.parentId}:{}),...(event.turnId&&eventId(event.turnId)?{turnId:event.turnId}:{})};
 window.dispatchEvent(new CustomEvent<AdminAgentOSChange>('galaxy:admin-agentos-change',{detail}));
}
const Cursor=createContext<{current:string|undefined}>({current:undefined});
export function useAdminEventCursorSeed(cursor:string|null|undefined){const target=useContext(Cursor);useLayoutEffect(()=>{if(cursor&&/^[0-9]{1,20}$/.test(cursor)&&(target.current===undefined||BigInt(cursor)<BigInt(target.current)))target.current=cursor;},[cursor,target]);}
export function AdminEventCursorSeed({cursor}:{cursor:string|null|undefined}){useAdminEventCursorSeed(cursor);return null;}
const Scope=createContext({endpoint:'',identity:'',surface:'admin' as const});
export const useAdminQueryScope=()=>useContext(Scope);
export {galaxyQueryKey};
export function AdminQueryProvider({children}:{children:ReactNode}){
 const {user}=useAuth(),identity=settingsOperatorId(user)??'';
 const [endpoint,setEndpoint]=useState('');useEffect(()=>setEndpoint(window.location.origin),[]);
 const scope=useMemo(()=>({endpoint,identity,surface:'admin' as const}),[endpoint,identity]);
 // Identity transition replaces the complete cache before children can observe it.
 return <IdentityQueries key={identity} scope={scope}>{children}</IdentityQueries>;
}
function IdentityQueries({children,scope}:{children:ReactNode;scope:{endpoint:string;identity:string;surface:'admin'}}){
 const [client]=useState(()=>createGalaxyQueryClient()),cursor=useRef<string|undefined>(undefined);
 useEffect(()=>{
  if(!scope.identity||!scope.endpoint)return;
  const stopActivity=observeUserActivity();
  const reset=(modules:string[])=>window.dispatchEvent(new CustomEvent('galaxy:admin-reset',{detail:modules}));
  const stream=createGalaxyEventClient({scope,queryClient:client,url:'/v1/operations/web-events',onReset:reset,onChange:agentOSChange,onResync:modules=>{if(modules.includes('agentos'))window.dispatchEvent(new CustomEvent<AdminAgentOSResync>('galaxy:admin-agentos-resync',{detail:{reason:'replay-gap'}}));},initialCursor:cursor.current});stream.start();
  let csrf='',expiresAt=0,lastUsed=0,active=true;const controller=new AbortController();
  const check=async()=>{
   const version=userActivityVersion();if(csrf&&(version<=lastUsed||Date.now()-version>60000))return;
   const headers:Record<string,string>={};if(csrf&&version>lastUsed&&Date.now()-version<60000){headers['X-Galaxy-User-Activity']='1';headers['X-Galaxy-Operator-CSRF']=csrf;lastUsed=version;}
   try{const response=await fetch('/v1/operations/session',{credentials:'same-origin',cache:'no-store',redirect:'error',headers,signal:controller.signal});
    if(!active)return;if(response.status===401||response.status===403){client.clear();reset([]);return;}
    if(!response.ok)return;const value=await response.json();if(value.state==='signed-out'||value.operator?.id!==scope.identity){client.clear();reset([]);return;}
    if(value.state==='signed-in'&&typeof value.csrfToken==='string'&&Number.isFinite(value.expiresAt)){csrf=value.csrfToken;expiresAt=value.expiresAt*1000;}
   }catch{/* Unknown transport state cannot revoke a still-valid lease. */}
  };
  void check();const timer=setInterval(()=>{if(expiresAt&&Date.now()>=expiresAt){client.clear();reset([]);expiresAt=0;}void check();},15000);
  return()=>{active=false;controller.abort();clearInterval(timer);stopActivity();stream.stop();client.clear();};
 },[client,scope]);
 return <Scope.Provider value={scope}><Cursor.Provider value={cursor}><QueryClientProvider client={client}>{children}</QueryClientProvider></Cursor.Provider></Scope.Provider>;
}
