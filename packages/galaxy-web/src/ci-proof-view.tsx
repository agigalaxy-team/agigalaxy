import React from 'react';
import {decodeJwt} from 'jose';
import type * as z from 'zod/v4';
import {ciProofV2Schema} from '../../galaxy-official/src/shared/ci-observation-v2-schema.mjs';
import './peering-ci.css';

export const ciConclusion:Record<string,string>={success:'CI 通过',failure:'CI 未通过',neutral:'CI 结果为中性',cancelled:'运行已取消',skipped:'运行已跳过',timed_out:'运行超时',action_required:'运行需要处理',stale:'运行结果已过期',startup_failure:'运行未能启动'};
export const ciTime=(value:unknown)=>value&&(typeof value==='string'||typeof value==='number')?new Date(typeof value==='number'&&value<1e12?value*1000:value).toLocaleString('zh-CN'):'';
const proofField=(value:unknown,key:string):unknown=>value&&typeof value==='object'?Reflect.get(value,key):undefined;
const proofSignature=(value:unknown)=>{const signed=proofField(value,'signed');return typeof signed==='string'?signed:null;};
type CiSource=Pick<z.infer<typeof ciProofV2Schema>['source'],'owner'|'repository'|'runId'|'attempt'|'commit'>;
export function ciProofData(value:unknown){
  try{
    const signed=proofSignature(value),candidate=proofField(value,'data')??(signed?decodeJwt(signed).data:value);
    const parsed=ciProofV2Schema.safeParse(candidate);return parsed.success?parsed.data:null;
  }catch{return null;}
}
export function CiSourceView({source}:{source?:CiSource|null}){
  if(!source)return null;
  return <dl className="material-facts"><div><dt>仓库</dt><dd>{source.owner}/{source.repository}</dd></div><div><dt>运行</dt><dd>第 {source.runId} 号 · 第 {source.attempt} 次尝试</dd></div><div><dt>提交版本</dt><dd className="material-code">{source.commit}</dd></div></dl>;
}
/** Signed input is displayed only after the current service has validated it. Decoding here is not verification. */
export function CiProofView({value,technical=true}:{value:unknown;technical?:boolean}){
  const data=ciProofData(value),signed=proofSignature(value);
  if(!data)return <p className="empty-state">这份证明暂时无法完整显示，请重新读取当前来源。</p>;
  return <div className="ci-proof-content">
    <h4>{data.source.owner}/{data.source.repository}</h4><p className="material-conclusion">{ciConclusion[data.conclusion??'']??'CI 未给出结论'}</p>
    {data.synthetic&&<p className="browse-note">这是合成演示资料。</p>}
    <CiSourceView source={data.source}/>
    <dl className="material-facts"><div><dt>采集时间</dt><dd>{ciTime(data.observedAt)}</dd></div><div><dt>证明有效至</dt><dd>{ciTime(data.expiresAt)}</dd></div><div><dt>签发服务</dt><dd>{data.issuer}</dd></div>{data.sourceControl?.repositoryOwner&&<div><dt>仓库所属账号</dt><dd>{data.sourceControl.repositoryOwner.login}</dd></div>}</dl>
    <p className="permission-line">这份证明仅说明这次 CI 运行的观察结果。运行由仓库控制；提交人的仓库控制权、独立执行、整个任务的结果和个人能力均未经这份证明认证。</p>
    {technical&&<details className="technical-details"><summary>证明原文与来源记录</summary><pre>{JSON.stringify(data,null,2)}</pre>{signed&&<><p>签发方原签名</p><pre>{signed}</pre></>}</details>}
  </div>;
}
