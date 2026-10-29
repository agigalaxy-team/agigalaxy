import Link from 'next/link';
import {aiManagementCapabilities,aiManagementFeatureLabel,type AiManagementFeature} from "../../lib/workbench/ai-management-capabilities";

function Feature({label,value}:{label:string;value:AiManagementFeature}){
 return <span className={'wb-management-feature'+(value.available?' is-available':'')}><strong>{label}</strong><span>{aiManagementFeatureLabel(value)}</span></span>;
}
export function WorkbenchManagementCapabilities({value}:{value:unknown}){
 const capabilities=aiManagementCapabilities(value);
 if(!capabilities)return <p className="wb-management-unavailable" role="status">管理权限加载失败</p>;
 return <section className="wb-management-capabilities" aria-label="总控当前管理能力">
  <header><h3>总控管理范围</h3><Link href="/admin/operations/ai-work-accounts?domain=overview&tab=roles" prefetch={false}>管理范围设置</Link></header>
  <dl><div><dt>岗位工作要求</dt><dd><Feature label="查看" value={capabilities.prompt.read}/><Feature label="修改" value={capabilities.prompt.update}/></dd></div><div><dt>AI专用角色</dt><dd>{([{key:'read',label:'读取'},{key:'create',label:'创建'},{key:'update',label:'修改'},{key:'assign',label:'分配'},{key:'revoke',label:'撤回'}] as const).map(action=><Feature key={action.key} label={action.label} value={capabilities.role[action.key]}/>)}</dd></div><div><dt>日常策略</dt><dd><Feature label="维护" value={capabilities.ordinaryStrategy.configure}/><Feature label="发布" value={capabilities.ordinaryStrategy.publish}/></dd></div><div><dt>设置</dt><dd><Feature label="模型" value={capabilities.modelConfiguration}/><Feature label="管理范围" value={capabilities.authorityBoundaries}/></dd></div></dl>
  {capabilities.targetAiAccounts.length>0&&<p className="wb-management-targets">获准岗位：{capabilities.targetAiAccounts.map(account=>account.name+(account.enabled?'':'（停用）')).join('、')}{capabilities.delegation.version!==null?' · 委派 v'+capabilities.delegation.version:''}</p>}
 </section>;
}
