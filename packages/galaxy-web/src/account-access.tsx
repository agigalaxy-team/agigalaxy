import React from 'react';
import {Cloud, FileText, Fingerprint, KeyRound, Laptop, Layers3, Monitor, Network, ShieldCheck, SlidersHorizontal, Sparkles} from 'lucide-react';
import './account-access.css';
import {LocalGalaxyEntry} from './local-galaxy-entry';

type Navigate = (path:string) => void;
type Props = {hasIdentity:boolean; connected:boolean; navigate:Navigate};

/** The three objects have separate ownership and lifetimes. Lines express a
 * relationship, never an implied grant of device or material permissions. */
export function IdentityRelationshipDiagram({compact=false}:{compact?:boolean}) {
  return <figure className={'identity-relationship'+(compact?' identity-relationship-compact':'')} aria-label="多个环境身份、控制设备与可选服务的关系示意">
    <span className="relationship-diagram-label">关系示意</span>
    <div className="environment-relationship-network" aria-hidden="true">
      <svg className="environment-relationship-lines" viewBox="0 0 500 220" preserveAspectRatio="none"><path d="M 185 48 H 310 M 185 172 H 245 V 48 H 310 M 185 48 H 220 V 172 H 310"/><circle cx="245" cy="48" r="3"/><circle cx="220" cy="172" r="3"/></svg>
      <span className="environment-id environment-id-a"><span className="environment-window-bar"><Layers3 size={13}/>Agent 环境 A<i/></span><span className="environment-window-id"><Fingerprint size={20}/><strong>ID A</strong></span><span className="environment-window-data"><FileText size={13}/>经历<SlidersHorizontal size={13}/>配置</span></span>
      <span className="environment-id environment-id-b"><span className="environment-window-bar"><Layers3 size={13}/>Agent 环境 B<i/></span><span className="environment-window-id"><Fingerprint size={20}/><strong>ID B</strong></span><span className="environment-window-data"><FileText size={13}/>经历<SlidersHorizontal size={13}/>配置</span></span>
      <span className="environment-official"><Cloud size={25}/><span><strong>一个银河账户</strong><small>官方线上基础服务</small></span></span>
      <span className="environment-hub"><Network size={25}/><span><strong>第三方 Hub</strong><small>也可以选择其他服务</small></span></span>
    </div>
    <figcaption><span><KeyRound size={16}/><strong>设备密钥负责控制</strong><small>登录账户不替代设备授权</small></span><span><Fingerprint size={16}/><strong>主体各自积累</strong><small>账户关联不合并身份与经历</small></span><span><Cloud size={16}/><strong>按需要选择服务</strong><small>一个官方账户可关联多个 ID</small></span></figcaption>
  </figure>;
}

export function AccountAccessWorkspace({hasIdentity,connected,navigate}:Props) {
  const identityTarget='/app/settings/identity?continue=access';
  return <section className="account-access-page">
    <header className="account-page-heading"><h1>接入与 AI</h1><p>由本机银河插件创建或接续 ID，再配合网页使用。</p></header>
    <div className="account-access-options">
      <section className="account-access-web" aria-labelledby="access-web-title">
        <div className="access-option-icon"><Monitor size={26}/></div><header><span className="account-section-label">本机接洽</span><h2 id="access-web-title">从本地银河继续</h2><p>在已安装银河的 AI 环境中继续。</p></header>
        <LocalGalaxyEntry introduction={false}/>
        <dl className="access-current-state"><div><dt>网页身份记录</dt><dd>{hasIdentity?'保留已有接续记录':'尚未接续身份'}</dd></div><div><dt>网页连接</dt><dd className={connected?'access-state-connected':''}>{connected?'已连接当前服务':'尚未连接'}</dd></div></dl>
        <p className="access-next-step">{connected?'已有网页连接保留。本机插件是否正在运行，需要发起接洽后核对。':hasIdentity?'已有身份材料和原操作保留。本机插件接洽后，按实际授权继续使用。':'先安装并打开本机银河。已有 ID 会沿用，新 ID 只在本地插件中创建。'}</p>
        {hasIdentity&&<a className="access-existing-devices" href={identityTarget} onClick={event=>{event.preventDefault();navigate(identityTarget);}}>查看已有身份与设备</a>}
      </section>
      <section className="account-access-host" aria-labelledby="access-host-title">
        <div className="access-option-icon"><Sparkles size={26}/></div><header><span className="account-section-label">自己的 AI</span><h2 id="access-host-title">回到熟悉的工作环境</h2><p>让自己的模型使用获准背景，查找帮助并接回结果。</p></header>
        <div className="access-host-preview" aria-hidden="true"><span className="access-host-window"><Laptop size={20}/><i/><i/><i/></span><span className="access-host-prompt">接着我正在做的事情</span><span className="access-host-source"><Fingerprint size={16}/>原身份<span/><ShieldCheck size={16}/>获准资料</span></div>
        <p className="access-next-step">安装工具会检查宿主与已有配置，保留该环境原有的 ID。模型由你自己提供，资料在实际使用时授权。</p>
        <div className="button-row"><a href="/downloads/" className="access-install-link">查看客户端与安装方式</a><a href="/docs/">阅读接入文档</a></div><p className="access-host-status">宿主中的安装与运行状态需在该环境确认，网页连接不表示 AI 已接入。</p>
      </section>
    </div>
    <section className="account-access-intro">
      <div><span className="account-section-label"><Fingerprint size={17}/>环境中的身份与积累</span><h2>每个 ID，持续积累。</h2><p>不同 Agent 环境可以有各自的银河 ID，记录相关经历与能力。设备负责控制，Hub 提供网络服务；官方银河账户可以关联多个 ID。</p><a href="/app/settings/identity?section=account" onClick={event=>{event.preventDefault();navigate('/app/settings/identity?section=account');}}>了解银河账户关联</a></div>
      <IdentityRelationshipDiagram/>
    </section>
    <section className="account-access-continuity"><ShieldCheck size={22}/><div><h2>身份、账户与资料分别授权</h2><p>官方账户登录后可查看已关联 ID；使用或关联 ID 需要本机插件参与。账户关联与设备接续都不会自动分享工作资料。</p></div></section>
  </section>;
}
