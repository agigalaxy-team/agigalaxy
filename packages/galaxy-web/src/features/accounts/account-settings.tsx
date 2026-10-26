import React from 'react';
import {IdentityRelationshipDiagram} from './identity-relationship-diagram';
import {LocalGalaxyEntry} from "../local-galaxy/local-galaxy-entry";
import {OfficialAccountStatus} from './official-account-panel';
import {AccountSessionScope,useAccountSessionModel} from './account-session-scope';

type Props={endpoint?:string;navigate?:(path:string)=>void;returnTo?:string;embedded?:boolean};
export function AccountSettings(props:Props){return <AccountSessionScope endpoint={props.endpoint}><AccountAssociation {...props}/></AccountSessionScope>;}
function AccountAssociation({navigate=(path)=>{location.href=path;},returnTo,embedded=false}:Props){
 const official=useAccountSessionModel();
 return <section className={'account-settings account-link-page'+(embedded?' account-association-embedded':'')}>
  {!embedded&&<header className="account-page-heading"><h1>关联本机 ID</h1></header>}
  {official.phase!=='signed-in'&&<OfficialAccountStatus model={official} navigate={navigate} returnTo="/app/account?section=access&action=association" resumeTo={returnTo} compact/>}
  {official.phase==='signed-in'&&<div className="account-association-workspace"><section className="account-association-current"><h2>让本机银河继续使用账户</h2><p className="account-local-explanation">同步你选择的资料，或在本机继续官网中的工作。</p><LocalGalaxyEntry purpose="association" introduction={false} returnTo={returnTo}/></section><aside className="account-association-explainer"><h2>本机 ID 与在线账户</h2><IdentityRelationshipDiagram compact/></aside></div>}
 </section>;
}
