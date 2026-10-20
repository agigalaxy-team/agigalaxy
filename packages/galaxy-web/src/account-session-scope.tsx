import React,{createContext,useContext} from 'react';
import {useOfficialAccountSession,type OfficialAccountModel} from './official-account-panel';

const AccountSessionContext=createContext<{endpoint?:string;model:OfficialAccountModel}|null>(null);

/** Reuse one verified account model across the navigation and its content. */
export function AccountSessionScope({endpoint,children}:{endpoint?:string;children:React.ReactNode}){
 const inherited=useContext(AccountSessionContext);
 if(inherited&&(endpoint===undefined||inherited.endpoint===endpoint))return <>{children}</>;
 return <OwnedAccountSession endpoint={endpoint}>{children}</OwnedAccountSession>;
}
function OwnedAccountSession({endpoint,children}:{endpoint?:string;children:React.ReactNode}){
 const model=useOfficialAccountSession(endpoint);
 return <AccountSessionContext.Provider value={{endpoint,model}}>{children}</AccountSessionContext.Provider>;
}
export function useAccountSessionModel(){
 const scope=useContext(AccountSessionContext);
 if(!scope)throw Error('AccountSessionScope is required');
 return scope.model;
}
