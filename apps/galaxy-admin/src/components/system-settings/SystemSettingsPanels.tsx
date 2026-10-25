'use client';

import type {ReactNode} from 'react';
import {systemSettingsState,systemSettingsServiceLabels,systemSettingsServiceKinds} from '../../lib/system-settings-view-model';
import type {SystemSettingsConsumer,SystemSettingsOperation,SystemSettingsServiceKind,SystemSettingsMail} from '../system-settings-types';

type SecretFields={key:string;label:string}[];

const consumerNames:Record<string,string>={operations:'运营邮件','account-authentication':'注册与密码重置','account-authentication-website':'网站账户邮件','account-authentication-management':'管理账户邮件','website-realm':'网站账户邮件','management-realm':'管理账户邮件','website-authentication':'网站账户邮件','management-authentication':'管理账户邮件','runtime-alerts':'运行告警','operations-api':'运营邮件 · 业务服务','operations-worker':'运营邮件 · 后台任务','public-website':'官网',api:'业务服务',worker:'后台任务',control:'配置服务',credential:'连接凭据'};

function consumerLabel(target:string){if(consumerNames[target])return consumerNames[target];for(const kind of systemSettingsServiceKinds)if(target===kind||target.startsWith(kind+'-'))return systemSettingsServiceLabels[kind]+(target===kind?'':' · '+(target.endsWith('-worker')?'后台任务':target.endsWith('-api')?'业务服务':'采用结果'));return '服务采用';}

const sourceNames:Record<string,string>={'operations-database':'运营配置','native-keycloak':'账户服务','native-alertmanager':'告警服务','protected-runtime':'当前运行配置','consumer-ack':'消费者回读','not-connected':'尚未接通'};

export const secretFields=(kind:'mail'|SystemSettingsServiceKind):SecretFields=>kind==='mail'?[{key:'user',label:'SMTP用户名'},{key:'password',label:'SMTP密码'}]:kind==='analysis'?[{key:'clientSecret',label:'采集客户端密钥'},{key:'readClientSecret',label:'读取客户端密钥'}]:kind==='ai-execution'?[{key:'signingKey',label:'执行签名密钥'},{key:'serviceKey',label:'运行服务密钥'}]:kind==='file-scanning'?[]:[{key:'apiKey',label:'API Key'}];

export function Panel({title,children,action}:{title:string;children:ReactNode;action?:ReactNode}){return <section className="ss-panel"><header><h2>{title}</h2>{action}</header>{children}</section>;}

export function Empty({children}:{children:ReactNode}){return <div className="ss-empty">{children}</div>;}

export function ConsumerState({rows,versionId,connections,bindings,loading=false}:{loading?:boolean;rows:SystemSettingsConsumer[];versionId:string|null;connections:{id:string;label:string}[];bindings?:SystemSettingsMail['configuration']['bindings']}){
 return rows.length?<dl className="ss-facts">{rows.map((row,index)=>{
  const label=consumerLabel(row.target);
  const purpose=row.target==='runtime-alerts'?'runtime-alerts':row.target.startsWith('operations')?'operations':['website-authentication','management-authentication','account-authentication','account-authentication-website','account-authentication-management','website-realm','management-realm'].includes(row.target)?'account-authentication':null;
  const inherited=bindings&&purpose!==null&&bindings[purpose]===null;
  const knownUnconfigured=row.state==='not-configured'&&row.configured===false&&row.connectionId===null&&row.adoptedVersionId===null;
  const adoption=inherited?'沿用现有配置':versionId&&row.adoptedVersionId===versionId?'已采用当前保存版本':row.adoptedVersionId?'采用其他已存版本':versionId?'版本采用尚未确认':'当前运行来源';
  return <div key={row.target+'-'+index}><dt>{label}</dt><dd><span className="ss-state" data-state={!inherited&&versionId&&row.adoptedVersionId===versionId?'applied':row.state}>{row.state==='configured'?'已有连接':row.state==='not-configured'?'尚未配置':row.state==='unavailable'?'暂不可读取':'采用状态未知'}</span>{!knownUnconfigured&&<p className="ss-muted">{row.connectionId?connections.find(value=>value.id===row.connectionId)?.label??'现有连接':row.configured===true?'现有连接':'连接信息暂未取得'} · {adoption}</p>}<p className="ss-muted">{sourceNames[row.source]??'来源暂未取得'}</p></dd></div>;
 })}</dl>:<Empty>{loading?<p role="status">正在读取采用状态…</p>:"当前采用结果暂未取得。"}</Empty>;
}

export function PhaseResults({operation,title}:{operation:SystemSettingsOperation|null;title?:string}){
 if(!operation)return null;
 const checkLabels={transport:'连接',authentication:'身份验证',index:'索引读取','reader-authentication':'读取凭据','writer-authentication':'写入凭据','scanner-signatures':'扫描签名',runtime:'运行服务','execution-signature':'执行签名'};
 return <Panel title={title??(operation.kind==='test'?'最近测试结果':'最近处理结果')}><p><span className="ss-state" data-state={operation.state}>{systemSettingsState(operation.state)}</span></p>{operation.phases.length>0&&<div className="ss-table-scroll"><table><thead><tr><th>用途或组件</th><th>结果</th></tr></thead><tbody>{operation.phases.map((row,index)=><tr key={row.target+'-'+index}><td>{consumerLabel(row.target)}</td><td>{systemSettingsState(row.state)}{row.code&&<p className="ss-muted">{phaseError(row.code)}</p>}{row.checks&&<ul className="ss-checks">{row.checks.map(check=><li key={check.kind}><span>{checkLabels[check.kind]}</span><strong data-state={check.state}>{check.state==='passed'?'通过':check.state==='failed'?'未通过':'未测试'}</strong></li>)}</ul>}</td></tr>)}</tbody></table></div>}</Panel>;
}

function phaseError(code:string){
 const labels:Record<string,string>={system_settings_adoption_unconfirmed:'尚未取得实际采用依据。',system_settings_apply_failed:'应用失败。',system_settings_apply_unknown:'应用结果暂未取得。',system_settings_test_failed:'连接测试未通过。',system_settings_connection_failed:'连接失败。',system_settings_credential_unavailable:'连接凭据暂不可用。',system_settings_configuration_incomplete:'连接参数尚未补齐。',system_settings_consumer_not_configured:'这项用途尚未接通。',system_settings_control_not_configured:'配置通道尚未接通。',system_settings_native_unavailable:'服务暂不可用。',system_settings_native_busy:'服务正在处理其他配置。',system_settings_source_changed:'官网内容已有更新，请读取后应用。',system_settings_mail_submission_unknown:'邮件提交结果暂未取得。',system_settings_mail_not_submitted:'邮件未提交。'};
 return labels[code]??'本项结果暂未取得。';
}

export function CredentialFields({kind,id,configured,disabled,values,onChange}:{kind:'mail'|SystemSettingsServiceKind;id:string;configured:boolean|null;disabled:boolean;values:Record<string,string>;onChange:(id:string,key:string,value:string)=>void}){
 const fields=secretFields(kind);if(!fields.length)return null;
 return <div className="ss-form"><div><h3>连接凭据</h3><p className="ss-muted">{configured===true?'已配置，留空保留。':configured===false?'尚未配置。':'配置状态暂未取得。'}</p></div><div className="ss-form-grid">{fields.map(field=><label key={field.key}>{field.label}<input type="password" autoComplete="new-password" maxLength={kind==='mail'&&field.key==='user'?320:4096} value={values[field.key]??''} disabled={disabled} placeholder={configured?'留空保留现有凭据':'填写本次使用的凭据'} onChange={event=>{const value=event.currentTarget.value;onChange(id,field.key,value);}}/></label>)}</div></div>;
}
