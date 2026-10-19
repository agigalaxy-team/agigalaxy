import React from 'react';
import {BookOpen,MessageSquare,ShieldCheck,Wrench} from 'lucide-react';
import {literalTaskText,hasMaterialText} from './task-material-client.mjs';
import type {TaskText} from './task-material-types';
import {identityPermissionGroups,identityPermissionLabel} from './identity-permission-labels.mjs';
import './agent-identity-workspace.css';
import './settings-visual.css';

const helpModes:Record<string,string> = {collaboration:'一起完成',stuck:'解决困难','proactive-review':'评审建议',diagnosis:'诊断问题',delegation:'委托一项工作'};
const visibilityNames:Record<string,string> = {Public:'公开求助',Private:'仅自己'};
const fingerprint = (value:string) => value.match(/.{1,4}/g)?.join(' ') ?? value;
export type AgentConnectionContext={scopes:string[];endpoint:string;targetPath:string;expiresAt:number;subjectId:string};
export type AgentDraftContent={title?:TaskText;summary?:TaskText;goal?:TaskText;situation?:TaskText;expectedOutcome?:TaskText;intent?:string;visibility?:string};
export function agentReturnLabel(path:string) {
 const route=path.split(/[?#]/)[0];
 return route==='/app/publish'?'继续填写求助':route.startsWith('/app/tasks/')?'回到原工作':route.startsWith('/app/capsules/')?'回到原方法':route.startsWith('/app/rooms/')?'回到原对话':route==='/app/'||route==='/app'?'回到发现':'回到原来的页面';
}

export function AgentConnectionSummary({context,deviceFingerprint,approved=false}:{context:AgentConnectionContext;deviceFingerprint?:string|null;approved?:boolean}) {
 const known=identityPermissionGroups.flatMap(group=>group.items.map(item=>item[0]));
 const groupIcon=(title:string)=>/交流|消息|社区/.test(title)?MessageSquare:/工作|方法|资料/.test(title)?BookOpen:/身份|设备|隐私/.test(title)?ShieldCheck:Wrench;
 return <section className="agent-connection-summary" aria-label="本次浏览器连接">
  <h3>{approved?'这台浏览器已获准的使用范围':'这台浏览器申请的使用范围'}</h3>
  <ul className="agent-permission-summary">{identityPermissionGroups.map(group=>{
   const values=group.items.filter(([key])=>context.scopes.includes(key));
   const Icon=groupIcon(group.title);return values.length>0?<li key={group.title}><Icon size={21} aria-hidden="true"/><div><strong>{group.title}</strong><span>{values.map(([,label])=>label).join('、')}</span></div></li>:null;
  })}{context.scopes.filter((scope:string)=>!known.includes(scope)).map((scope:string)=><li key={scope}>{identityPermissionLabel(scope)}</li>)}</ul>
  {deviceFingerprint&&<div className="agent-device-check"><p>请与本机 AI 的连接页面对照这串设备核对码：</p><code>{fingerprint(deviceFingerprint)}</code></div>}
  <dl className="agent-connection-destination"><dt>连接的服务</dt><dd>{context.endpoint}</dd><dt>连接后</dt><dd>{agentReturnLabel(context.targetPath)}</dd><dt>申请有效至</dt><dd>{new Date(context.expiresAt*1000).toLocaleString('zh-CN')}</dd></dl>
  <details className="agent-exact-connection"><summary>准确身份与连接信息</summary><dl><dt>银河 ID</dt><dd><code>{context.subjectId}</code></dd><dt>原页面</dt><dd><code>{context.targetPath}</code></dd><dt>协议中的范围</dt><dd><code>{context.scopes.join('、')}</code></dd></dl></details>
 </section>;
}

export function AgentDraftSummary({value,title}:{value:AgentDraftContent;title:string}) {
 return <section className="agent-draft-reading"><p className="agent-draft-origin">{title}</p><h4>{literalTaskText(value.title)||'尚未填写独立标题'}</h4>
  {value.summary&&<p className="agent-draft-body">{literalTaskText(value.summary)}</p>}
  {value.goal&&value.goal!==value.title&&<><h5>具体目标</h5><p className="agent-draft-body">{literalTaskText(value.goal)}</p></>}
  {value.situation&&<><h5>当前情况</h5><p className="agent-draft-body">{literalTaskText(value.situation)}</p></>}
  {value.expectedOutcome&&<><h5>希望得到的结果</h5><p className="agent-draft-body">{literalTaskText(value.expectedOutcome)}</p></>}
  {[value.title,value.summary,value.goal,value.situation,value.expectedOutcome].some(hasMaterialText)&&<p>这里显示独立说明，选定的来源材料请回原求助稿核对。</p>}
  <dl className="agent-draft-scope"><dt>帮助方式</dt><dd>{helpModes[value.intent??'']??'尚未选择'}</dd><dt>计划可见范围</dt><dd>{visibilityNames[value.visibility??'']??'尚未选择'}</dd></dl>
 </section>;
}
