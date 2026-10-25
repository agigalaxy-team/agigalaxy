import React,{createContext,useContext,useLayoutEffect,useMemo,useRef} from 'react';
import {useOfficialAccountSession,type OfficialAccountModel} from './official-account-panel';
import {createOnlineAccountDraftMemory,type OnlineAccountDraftMemory} from './online-account-draft-memory';

const AccountSessionContext=createContext<{endpoint?:string;model:OfficialAccountModel;draftMemory:OnlineAccountDraftMemory}|null>(null);

/** Reuse one verified account model across the navigation and its content. */
export function AccountSessionScope({endpoint,children}:{endpoint?:string;children:React.ReactNode}){
 const inherited=useContext(AccountSessionContext);
 if(inherited&&(endpoint===undefined||inherited.endpoint===endpoint))return <>{children}</>;
 return <OwnedAccountSession endpoint={endpoint}>{children}</OwnedAccountSession>;
}
function OwnedAccountSession({endpoint,children}:{endpoint?:string;children:React.ReactNode}){
 const model=useOfficialAccountSession(endpoint);
 const latest=useRef(model);latest.current=model;
 const draftMemory=useMemo(()=>createOnlineAccountDraftMemory(()=>latest.current),[endpoint]);
 useLayoutEffect(()=>{draftMemory.activate();return()=>draftMemory.close();},[draftMemory]);
 useLayoutEffect(()=>{draftMemory.synchronize();},[draftMemory,model.phase,model.client,model.session]);
 return <AccountSessionContext.Provider value={{endpoint,model,draftMemory}}>{children}</AccountSessionContext.Provider>;
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
