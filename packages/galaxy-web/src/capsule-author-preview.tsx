import React from 'react';
import {memberName,readableTime} from './conversation-ui';
import {SourceReading,sourceKind} from './capsule-authoring-shared';
import type {CapsuleAuthoredPreview,CapsulePreviewDisplay} from './capsule-authoring-types';
type PreviewProps={preview:CapsuleAuthoredPreview;display?:CapsulePreviewDisplay;subjectId:string;names:Record<string,string|null>};
export function CapsuleAuthorPreview({preview,display={},subjectId,names}:PreviewProps){
 const {type,payload}=preview,people=(ids:string[])=>[...new Set(ids)].map(id=>memberName(id,subjectId,names[id]??undefined)).join('、');
 return <div className="method-complete-preview">
  <p className="method-preview-scope">{preview.visibility==='Public'?'公开展示':preview.viewers.length?'本人和 '+people(preview.viewers)+' 可阅读':'仅本人可阅读'}</p>
  {type==='publication'&&payload.kind==='version'?<>
   <header><p className="eyebrow">第 {payload.version} 版{payload.synthetic?' · 合成演示':''}</p><h3>{payload.title}</h3><p className="reading-prose">{payload.problemPattern}</p></header>
   <section><h3>具体做法</h3><p className="reading-prose">{payload.solutionStrategy}</p></section>
   <section><h3>适用条件</h3><p>{payload.environment.name} / {payload.environment.version}</p><p className="reading-prose">{payload.applicableScope}</p></section>
   <section><h3>核对效果</h3><p className="reading-prose">{payload.verificationMethod}</p></section>
   <section><h3>限制与不适用情况</h3><ul>{payload.limitations.map((line:string,index:number)=><li key={index}>{line}</li>)}</ul></section>
   {!![...payload.tools,...payload.skills,...payload.mcpRefs].length&&<section><h3>使用的工具与能力</h3>{([['tools','工具'],['skills','Skill'],['mcpRefs','MCP']] as const).map(([key,label])=>payload[key].length?<p key={key}>{label}：{payload[key].join('、')}</p>:null)}</section>}
   <section><h3>实际来源与作者</h3><p>{display.sourceTitle??'已核对所选实际工作'}</p><div className="method-preview-sources">{(display.sources??[]).map(item=><SourceReading key={item.ref.kind+':'+item.ref.id+':'+item.ref.version} {...{item,subjectId,names}} compact/>)}</div><p className="source-reading-note">来源作者：{people(payload.contributors)||'没有额外署名'}。来源署名保留内容归属；共同署名仍需对方自己的回应。</p></section>
   <section><h3>内容许可</h3><p>{payload.license}</p>{(display.permissions??[]).map(permission=><article className="method-permission-card" key={permission.permissionId}><h4>{memberName(permission.authorId,subjectId,names[permission.authorId]??undefined)}</h4><p className="reading-prose">{permission.payload.scope}</p><p>署名要求：{permission.payload.attribution}</p><p className="source-reading-note">{permission.payload.allowPublic?'允许在许可范围内公开':'仅在所选非公开范围使用'}{permission.payload.expiresAt?' · 截至 '+readableTime(permission.payload.expiresAt):''}</p></article>)}{!!display.unavailablePermissionIds?.length&&<p className="source-reading-note">以前引用的部分许可没有沿用。本次已按当前内容与范围重新核对有效许可。</p>}</section>
   {!!payload.externalReferences.length&&<section><h3>外部参考</h3>{payload.externalReferences.map(item=><p key={item.url}><a href={item.url} target="_blank" rel="noreferrer">{item.description}</a>{item.license?' · '+item.license:''}</p>)}</section>}
   <p className="method-publication-intent">确认保存表示你已核对以上本人编写的文字、准确来源和分享范围。</p>
  </>:type==='publication'&&payload.kind!=='version'?<>
   <h3>{display.title??'选定方法'}</h3><p>{({deprecate:'停用这一版本','security-issue':'说明安全事项','resolve-security':'记录安全事项处理'} as Record<string,string>)[payload.kind]}</p><p className="reading-prose">{payload.summary}</p><p className="source-reading-note">保留这一版本的原展示范围和此前发生的使用记录。</p>
  </>:type==='permission'&&payload.kind==='grant'?<>
   <h3>允许 {people(payload.grantees)} 使用选定来源</h3><div className="method-preview-sources">{(display.sources??[]).map(item=><SourceReading key={item.ref.kind+':'+item.ref.id+':'+item.ref.version} {...{item,subjectId,names}} compact/>)}</div>
   <section><h3>允许使用的范围</h3><p className="reading-prose">{payload.scope}</p><p>{payload.allowPublic?'允许在这项许可范围内公开选定内容。':'仅按这项许可使用，不允许公开选定内容。'}</p></section>
   <section><h3>许可与署名</h3><p>{payload.license}</p><p className="reading-prose">{payload.attribution}</p><p>{payload.basis==='documented-covering-license'?'依据覆盖许可文件：'+payload.licenseReference:'由本人许可自己创作的选定内容。'}</p><p>{payload.expiresAt?'额外截止时间：'+readableTime(payload.expiresAt):'未另设截止时间，仍受原授权有效期限制。'}</p></section>
  </>:type==='permission'&&payload.kind==='revoke'?<>
   <h3>撤销这项来源许可</h3><p className="reading-prose">{display.title??'所选原许可'}</p><p className="reading-prose">{payload.reason}</p><p>依赖这项许可的内容会重新核对当前可读性；已经发生的工作仍保留。</p>
  </>:null}
  <details className="source-reference-details"><summary>准确版本与记录详情</summary><dl><dt>本次记录</dt><dd>{payload.id}</dd>{'sourceResolution' in payload&&<><dt>来源结果</dt><dd>{payload.sourceResolution.resultId} · 第 {payload.sourceResolution.resultVersion} 版</dd></>}{('sourceRefs' in payload?payload.sourceRefs:'sources' in payload?payload.sources:[]).map(ref=><React.Fragment key={ref.kind+':'+ref.id+':'+ref.version}><dt>{sourceKind(ref.kind)}</dt><dd>{ref.id} · 第 {ref.version} 版</dd></React.Fragment>)}</dl></details>
 </div>;
}
