import React from 'react';
import {ArrowRight,Cloud,KeyRound,Laptop,Link2,ShieldCheck,Unplug} from 'lucide-react';
import {Button} from '@/components/ui/button';
import './settings-visual.css';

export type IdentityConnectionOverviewProps={subjectId:string;deviceId?:string;endpoint:string;connected:boolean;unavailable?:boolean;busy?:boolean;onContinue:()=>void;onDisconnect?:()=>void};
const serviceName=(endpoint:string)=>{try{const host=new URL(endpoint).hostname;return ['127.0.0.1','localhost','[::1]'].includes(host)?'本机服务':host;}catch{return '选定的服务';}};

export function IdentityConnectionOverview({subjectId,deviceId,endpoint,connected,unavailable=false,busy=false,onContinue,onDisconnect}:IdentityConnectionOverviewProps){
 const status=unavailable?'需要重新接续':connected?'已连接':'身份保存在本机';
 return <section className="identity-current-panel connection-overview" aria-label="当前身份与连接">
  <header className="connection-overview-heading"><span className="setting-symbol"><KeyRound size={24} aria-hidden="true"/></span><div><p className="setting-eyebrow">当前在使用</p><h2>一个身份，接着做自己的事</h2></div><span className={'setting-signal '+(connected&&!unavailable?'is-current':'is-neutral')}><ShieldCheck size={15} aria-hidden="true"/>{status}</span></header>
  <ol className={'connection-map '+(connected&&!unavailable?'is-connected':'')} aria-label="本机、身份与服务的关系">
   <li><Laptop size={28} aria-hidden="true"/><strong>这台浏览器</strong><span>{deviceId?'使用本机设备材料':'保留本机身份材料'}</span></li><li className="connection-map-arrow" aria-hidden="true"><ArrowRight size={24}/></li>
   <li><KeyRound size={28} aria-hidden="true"/><strong>你的银河身份</strong><span>工作与资料沿原身份继续</span></li><li className="connection-map-arrow" aria-hidden="true"><ArrowRight size={24}/></li>
   <li><Cloud size={28} aria-hidden="true"/><strong>{serviceName(endpoint)}</strong><span>{connected&&!unavailable?'当前连接的服务':'连接后读取获准内容'}</span></li>
  </ol>
  <div className="connection-overview-actions"><p>{unavailable?'这台设备不能继续原连接，使用管理设备或恢复码接回。':connected?'可以回到刚才的页面，继续阅读、交流和工作。':'身份仍在这台设备上。连接后继续原来的页面。'}</p><div className="button-row"><Button id="connect-current-identity" disabled={busy||unavailable} onClick={onContinue}><Link2 size={16} aria-hidden="true"/>{connected?'返回继续':'连接并继续'}</Button>{connected&&onDisconnect&&<Button variant="ghost" disabled={busy} onClick={onDisconnect}><Unplug size={16} aria-hidden="true"/>断开本次连接</Button>}</div></div>
  <details className="identity-reference"><summary>准确身份与服务</summary><dl><dt>银河身份</dt><dd><code>{subjectId}</code></dd>{deviceId&&<><dt>本机设备</dt><dd><code>{deviceId}</code></dd></>}<dt>服务</dt><dd>{endpoint}</dd></dl></details>
 </section>;
}
