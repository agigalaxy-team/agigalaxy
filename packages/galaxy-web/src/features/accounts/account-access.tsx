import React from 'react';
import {Fingerprint,Laptop} from 'lucide-react';
import {AccountSessionScope,useAccountSessionModel} from './account-session-scope';
import {AccountSettings} from './account-settings';
import {LocalGalaxyEntry} from "../local-galaxy/local-galaxy-entry";
import {profilePath} from "../profiles/profile-navigation.mjs";
import {LoadingFeedback,ReadFailure} from "../../shared/feedback/interaction-feedback";
import './account-access.css';
export {IdentityRelationshipDiagram} from './identity-relationship-diagram';

export type AccountConnectionAction='overview'|'association'|'native';
export type AccountAccessProps={endpoint?:string;navigate:(path:string)=>void;identityControls?:React.ReactNode;section?:AccountConnectionAction;returnTo?:string;onAction?:(action:AccountConnectionAction)=>void};
export function AccountAccessWorkspace(props:AccountAccessProps){return <AccountSessionScope endpoint={props.endpoint}><AccountConnections {...props}/></AccountSessionScope>;}
function AccountConnections({endpoint,navigate,identityControls,section='overview',returnTo,onAction}:AccountAccessProps){
 const model=useAccountSessionModel(),session=model.phase==='signed-in'?model.session:null;
 const choose=(action:AccountConnectionAction)=>{if(onAction)onAction(action);else navigate('/app/account?section=access'+(action==='overview'?'':'&action='+action));};
 const selected=section!=='overview';
 const title=section==='association'?'关联本机 ID':section==='native'?'连接本机银河':'本机银河';
 return <section className="account-access-page account-connections"><header className="account-page-heading">{selected&&<button type="button" className="back-link" onClick={()=>choose('overview')}>本机银河</button>}<h1>{title}</h1></header>
  {section==='association'?<AccountSettings endpoint={endpoint} navigate={navigate} returnTo={returnTo} embedded/>:selected?<section className="account-connection-action">{identityControls??<LocalGalaxyEntry introduction={false} returnTo={returnTo}/>}</section>:<>
   <LoadingFeedback active={model.phase==='loading'||model.busy} label="正在读取关联…" scopeKey={model.session?.account.id??'connections'}/>
   {model.phase==='unavailable'&&<ReadFailure message="账户关联暂时无法读取。" onRetry={()=>void model.refresh()} retrying={model.busy}/>}
   {model.phase==='offline'&&<p className="account-connection-note">暂时离线，联网后继续读取。</p>}
   {session&&<section className="account-linked-identities"><header><h2>已关联的 ID</h2><button type="button" className="text-link" onClick={()=>choose('association')}>关联本机 ID</button></header>{session.linkedIds.length?<ul>{session.linkedIds.map(item=>{const path=profilePath(item.subjectId);return <li key={item.subjectId}><Fingerprint size={22} aria-hidden="true"/><div>{path?<a href={path} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(path);}}}><code>{item.subjectId}</code></a>:<code>{item.subjectId}</code>}<p>关联于 {new Date(item.linkedAt).toLocaleDateString('zh-CN')}</p></div></li>;})}</ul>:<p className="account-connection-note">尚未关联本机 ID。</p>}{session.nextAfter&&<button type="button" className="text-link" disabled={model.busy} onClick={()=>void model.more()}>更多关联</button>}</section>}
   {identityControls?<section className="account-connection-action">{identityControls}</section>:<section className="account-native-continue"><Laptop size={26} aria-hidden="true"/><div><h2>在自己的 AI 中继续工作</h2><LocalGalaxyEntry introduction={false} returnTo={returnTo}/></div></section>}
   <footer className="account-access-links"><a href="/downloads/">客户端与安装</a><a href="/docs/">使用文档</a></footer>
  </>}
 </section>;
}
