import React from 'react';
import {Cloud, FileText, Fingerprint, KeyRound, Laptop, Layers3, Monitor, Network, ShieldCheck, SlidersHorizontal, Sparkles} from 'lucide-react';
import './account-access.css';
import {LocalGalaxyEntry} from './local-galaxy-entry';

type Navigate = (path:string) => void;
type Props = {hasIdentity:boolean; connected:boolean; navigate:Navigate};

/** The three objects have separate ownership and lifetimes. Lines express a
 * relationship, never an implied grant of device or material permissions. */
export function IdentityRelationshipDiagram({compact=false}:{compact?:boolean}) {
  return <figure className={'identity-relationship'+(compact?' identity-relationship-compact':'')} aria-label="多个主体 ID 与多个在线账户的关联示意">
    <span className="relationship-diagram-label">关系示意</span>
    <div className="environment-relationship-network" aria-hidden="true">
      <svg className="environment-relationship-lines" viewBox="0 0 500 220" preserveAspectRatio="none"><path d="M 185 48 H 310 M 185 172 H 245 V 48 H 310 M 185 48 H 220 V 172 H 310"/><circle cx="245" cy="48" r="3"/><circle cx="220" cy="172" r="3"/></svg>
      <span className="environment-id environment-id-a"><span className="environment-window-bar"><Layers3 size={13}/>个人或组织主体<i/></span><span className="environment-window-id"><Fingerprint size={20}/><strong>ID A</strong></span><span className="environment-window-data"><FileText size={13}/>经历<SlidersHorizontal size={13}/>配置</span></span>
      <span className="environment-id environment-id-b"><span className="environment-window-bar"><Layers3 size={13}/>Worker 的 Agent 主体<i/></span><span className="environment-window-id"><Fingerprint size={20}/><strong>ID B</strong></span><span className="environment-window-data"><FileText size={13}/>经历<SlidersHorizontal size={13}/>配置</span></span>
      <span className="environment-official"><Cloud size={25}/><span><strong>银河账户 A</strong><small>可关联多个 ID</small></span></span>
      <span className="environment-hub"><Cloud size={25}/><span><strong>银河账户 B</strong><small>同一 ID 也可关联</small></span></span>
    </div>
    <figcaption><span><KeyRound size={16}/><strong>设备密钥负责控制</strong><small>登录账户不替代设备授权</small></span><span><Fingerprint size={16}/><strong>主体各自积累</strong><small>账户关联不合并身份与经历</small></span><span><Cloud size={16}/><strong>每条关联分别授权</strong><small>数据、权限与动作来源各自保留</small></span></figcaption><p className="identity-service-choice"><Network size={15}/>本地也可选择第三方 Hub；官网不管理第三方接入。</p>
  </figure>;
}

export function AccountAccessWorkspace({hasIdentity,connected,navigate}:Props) {
 const identityTarget='/app/settings/identity?continue=access';
 return <section className="account-access-page"><header className="account-page-heading"><h1>接入</h1></header>
 <section className="account-local-connect"><div className="access-option-icon"><Laptop size={26}/></div><div><h2>在自己的 AI 中使用银河</h2><p>打开已安装银河的 AI 环境，继续当前工作。</p><LocalGalaxyEntry introduction={false} hasIdentity={hasIdentity}/></div></section>
 {hasIdentity&&<section className="account-web-connection"><h2>这台浏览器</h2><p>{connected?'已连接，可继续使用当前身份。':'已有身份记录，连接后继续。'}</p><a href={identityTarget} onClick={event=>{event.preventDefault();navigate(identityTarget);}}>身份与设备</a></section>}
 <nav className="account-access-links" aria-label="接入设置"><a href="/app/settings/identity?section=account" onClick={event=>{event.preventDefault();navigate('/app/settings/identity?section=account');}}>关联银河账户</a><a href="/downloads/">客户端与安装</a><a href="/docs/">接入文档</a></nav>
 </section>;
}
