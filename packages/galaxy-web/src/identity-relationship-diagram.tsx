import React from 'react';
import {Cloud,FileText,Fingerprint,KeyRound,Layers3,Network,SlidersHorizontal} from 'lucide-react';
import './account-access.css';

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

