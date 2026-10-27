import {QueryClientContext,QueryClientProvider} from '@tanstack/react-query';
import {createGalaxyQueryClient,galaxyQueryKey,type GalaxyQueryScope} from '../../shared/runtime/query-client';
import {createGalaxyEventClient} from '../../shared/runtime/event-stream';
import {observeUserActivity} from '../../shared/runtime/activity';
import React,{createContext,useContext,useLayoutEffect,useEffect,useMemo,useRef} from 'react';
import {useOfficialAccountSession,type OfficialAccountModel} from './official-account-panel';
import {createOnlineAccountDraftMemory,type OnlineAccountDraftMemory} from './online-account-draft-memory';

const AccountSessionContext=createContext<{endpoint?:string;model:OfficialAccountModel;draftMemory:OnlineAccountDraftMemory;query:ReturnType<typeof createGalaxyQueryClient>;queryScope:GalaxyQueryScope|null}|null>(null);

/** Reuse one verified account model across the navigation and its content. */
export function AccountSessionScope({endpoint,children}:{endpoint?:string;children:React.ReactNode}){
 const inherited=useContext(AccountSessionContext);
 if(inherited&&(endpoint===undefined||inherited.endpoint===endpoint))return <>{children}</>;
 return <OwnedAccountSession endpoint={endpoint}>{children}</OwnedAccountSession>;
}
function OwnedAccountSession({endpoint,children}:{endpoint?:string;children:React.ReactNode}){
 const model=useOfficialAccountSession(endpoint);
 const parentQuery=useContext(QueryClientContext);
 const ownedQuery=useMemo(()=>createGalaxyQueryClient(),[]);
 const query=parentQuery??ownedQuery;
 const id=model.session?.account.id,csrf=model.session?.csrfToken;
 const queryScope=useMemo<GalaxyQueryScope|null>(()=>endpoint&&id?{endpoint,identity:id,surface:'web'}:null,[endpoint,id]);
 useEffect(observeUserActivity,[]);
 useLayoutEffect(()=>()=>{if(id&&endpoint)query.removeQueries({queryKey:['galaxy',endpoint.replace(/\/$/,''),'web',id]});},[query,id,endpoint]);
 useEffect(()=>{
  if(!queryScope||!csrf)return;
  const events=createGalaxyEventClient({scope:queryScope,queryClient:query,topics:['account','account-work','bookmarks','follows','forum','chat','tasks','projects','contacts'],headers:{'X-Galaxy-Account-ID':queryScope.identity},onReset:modules=>{if(modules.includes('account'))void latest.current.refresh();}});
  events.start();return()=>events.stop();
 },[query,queryScope,csrf]);
 const latest=useRef(model);latest.current=model;
 const draftMemory=useMemo(()=>({endpoint,memory:createOnlineAccountDraftMemory(()=>latest.current)}),[endpoint]).memory;
 useLayoutEffect(()=>{draftMemory.activate();return()=>draftMemory.close();},[draftMemory]);
 useLayoutEffect(()=>{draftMemory.synchronize();},[draftMemory,model.phase,model.client,model.session]);
 const content=<AccountSessionContext.Provider value={{endpoint,model,draftMemory,query,queryScope}}>{children}</AccountSessionContext.Provider>;
 return parentQuery?content:<QueryClientProvider client={query}>{content}</QueryClientProvider>;
}
export function useAccountSessionModel(){
 const scope=useContext(AccountSessionContext);
 if(!scope)throw Error('AccountSessionScope is required');
 return scope.model;
}
export function useOnlineAccountDraftMemory(){
 const scope=useContext(AccountSessionContext);
 if(!scope)throw Error('AccountSessionScope is required');
 return scope.draftMemory;
}

export function useAccountQueryScope(){
 const scope=useContext(AccountSessionContext);
 if(!scope)throw Error('AccountSessionScope is required');
 return {query:scope.query,scope:scope.queryScope,key:(...parts:unknown[])=>scope.queryScope?galaxyQueryKey(scope.queryScope,'chat',...parts):['unavailable']};
}
