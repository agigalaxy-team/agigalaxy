import React,{useEffect,useRef,useState} from 'react';
import {ArrowRight,Award,BookOpen} from 'lucide-react';
import {createProfileClient} from './profile-client.mjs';
import {profileExperiencePath} from './profile-navigation.mjs';
import {recognitionReading} from './person-recognition-view.mjs';
import type {PersonOverview,HonorBadge,HonorDetail,HonorResponse} from './account-workspace-types';
import './person-recognitions.css';

type Go=(path:string)=>void;
type Common={profile:PersonOverview;recognitionPath:(id?:string)=>string;navigate:Go};
function Link({to,navigate,children,...rest}:{to:string;navigate:Go;children:React.ReactNode}&Omit<React.ComponentPropsWithoutRef<'a'>,'href'|'onClick'>){return <a href={to} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(to);}}} {...rest}>{children}</a>;}
const date=(seconds:number|null)=>seconds===null?'未提供':new Date(seconds*1000).toLocaleDateString('zh-CN');
const issuerName=(issuer:string)=>{try{return new URL(issuer).host;}catch{return issuer||'未提供';}};

export function RecognitionOverview({profile,recognitionPath,navigate}:Common){
 return <section className="person-section"><header><h2>贡献认可</h2>{profile.honors.length>0&&<Link to={recognitionPath()} navigate={navigate}>查看全部<ArrowRight size={14}/></Link>}</header>
  {profile.honors.length?<div className="person-recognition-links">{profile.honors.slice(0,4).map(item=><Link key={item.id} to={recognitionPath(item.id)} navigate={navigate}><Award size={25}/><span>{item.title}</span></Link>)}</div>:<p className="person-muted">{profile.honorsError?'认可资料暂时不可读取。':'暂无可查看的认可。'}</p>}
 </section>;
}

export function PersonRecognitions({client,profile,refresh,selectedId,recognitionPath,experience,navigate}:{client:ReturnType<typeof createProfileClient>;refresh:number;selectedId:string|null;experience:string}&Common){
 const selected=profile.honors.find(item=>item.id===selectedId)??(!selectedId?profile.honors[0]:undefined);
 return <section className="recognition-reading"><header className="recognition-section-heading"><div><h2>贡献认可</h2><p>从具体参与中形成的认可，连同当时的范围和当前可读依据一起查看。</p></div></header>
  {profile.honors.length>1&&<nav className="recognition-choices" aria-label="选择贡献认可">{profile.honors.map(item=><Link key={item.id} to={recognitionPath(item.id)} navigate={navigate} aria-current={selected?.id===item.id?'page':undefined}><Award size={20}/>{item.title}</Link>)}</nav>}
  {selected?<RecognitionDetail key={selected.id} {...{client,profile,refresh,experience,navigate}} item={selected}/>:<div className="recognition-empty"><Award size={35}/><h3>{selectedId?'这项认可当前不可查看':'暂无可查看的认可'}</h3><p>{profile.honorsError?'当前认可资料暂未读取成功。可以先阅读已分享的经历。':selectedId?'认可依据或可见范围已变化。已分享的经历仍按各自范围提供。':'已分享的经历可以直接阅读，参与记录按其实际内容呈现。'}</p><Link to={experience} navigate={navigate}>查看经历与贡献<ArrowRight size={15}/></Link></div>}
 </section>;
}

type HonorRead={profile:PersonOverview;refresh:number;retry:number;detail:HonorDetail|null;error:string};
function currentHonorDetail(value:HonorResponse):HonorDetail{
 if(value.card.status!=='active')throw Error('honor_changed');
 return {...value,items:value.items??value.contributions??[],nextAfter:value.nextAfter??value.pagination?.contributions?.nextAfter??null,sourceFingerprint:value.sourceFingerprint??value.card.sourceFingerprint};
}
const honorError=(error:unknown)=>error instanceof Error&&error.message==='honor_changed'?'这项认可的当前依据已变化。':'当前依据暂时不可读取。';
function RecognitionDetail({client,profile,refresh,item,experience,navigate}:{client:ReturnType<typeof createProfileClient>;profile:PersonOverview;refresh:number;item:HonorBadge;experience:string;navigate:Go}){
 const [result,setResult]=useState<HonorRead|null>(null),[retry,setRetry]=useState(0),[moreFor,setMoreFor]=useState<HonorRead|null>(null),control=useRef({sequence:0});
 const current=result?.profile===profile&&result.refresh===refresh&&result.retry===retry?result:null;
 const detail=current?.detail,error=current?.error,busy=!current||moreFor===current,reading=detail?recognitionReading(detail):null;
 useEffect(()=>{const state=control.current,token=++state.sequence;
  client.honor(item,{}).then(value=>{const next=currentHonorDetail(value);if(state.sequence===token)setResult({profile,refresh,retry,detail:next,error:''});}).catch(error=>{if(state.sequence===token)setResult({profile,refresh,retry,detail:null,error:honorError(error)});});
  return()=>{state.sequence++;};
 },[client,profile,refresh,item,retry]);
 async function readMore(){
  if(!current||!detail?.nextAfter||busy)return;
  const state=control.current,token=state.sequence;setMoreFor(current);
  try{const value=await client.honor(item,{after:detail.nextAfter,expectedFingerprint:detail.sourceFingerprint}),next=currentHonorDetail(value);
   if(state.sequence===token)setResult({...current,detail:{...next,items:[...detail.items,...next.items]},error:''});
  }catch(error){if(state.sequence===token)setResult({...current,detail:null,error:honorError(error)});}
 }
 return <article className="recognition-detail" aria-busy={busy}><header className="recognition-title"><span className="recognition-seal" aria-hidden="true"><Award size={39}/></span><div><p className="eyebrow">贡献认可</p><h3>{item.title}</h3>{reading&&<p>由 {issuerName(reading.issuer)} 按第 {reading.version} 版规则形成</p>}</div></header>
  {busy&&!detail&&<output>正在读取依据…</output>}{error&&<p role="alert" className="person-read-error">{error}<button type="button" onClick={()=>setRetry(value=>value+1)}>重新读取</button></p>}
  {detail&&reading&&<><section className="recognition-meaning"><h4>这项认可表示什么</h4><p>{reading.kind==='ci-backed-contributor'?'在限定范围内有已被接收的参与工作，并有规则所要求的自动检查证据。':'在限定范围内，参与公开求助的工作已被接收。'}{reading.factsV2?'被接收的是具体贡献，部分完成和未达目标的工作也保留实际结果。':''}</p><dl className="recognition-scope"><div><dt>参与时间范围</dt><dd>{date(reading.from)} — {date(reading.until)}<small>截至结束日期之前</small></dd></div><div><dt>当前计入的工作</dt><dd>{reading.acceptedCases===null?'未提供':reading.acceptedCases+' 件'}</dd></div><div><dt>规则要求</dt><dd>{reading.minimumCases===null?'按下方规则版本':reading.minimumCases+' 件不同工作的参与被接收'}{reading.minimumProofs!==null&&reading.minimumProofs>0&&<small>另需 {reading.minimumProofs} 份范围内自动检查证据</small>}</dd></div></dl><p className="recognition-boundary">这一标志说明上述贡献；完整结果和使用条件见各条经历。当前是否愿意交流，以作品页开放的联系范围为准。</p></section>
   <section className="recognition-evidence"><header><h4>依据哪些参与</h4><Link to={experience} navigate={navigate}><BookOpen size={15}/>完整经历</Link></header><ol>{reading.rows.map(evidence=><li key={evidence.key}><div><h5>{evidence.title}</h5><p className="recognition-evidence-state">{evidence.synthetic?'合成示例，不计入认可':evidence.eligible?'计入当前认可':'相关记录，当前未计入'}{evidence.participatedAt!==null?' · '+date(evidence.participatedAt):''}</p></div>{evidence.summaries.map((summary,index)=><p className="reading-prose" key={index}>{summary}</p>)}{evidence.recordKey&&<Link to={profileExperiencePath(profile.subjectId,evidence.recordKey)!} navigate={navigate}>阅读这段经历<ArrowRight size={15}/></Link>}</li>)}</ol>{!reading.rows.length&&<p>当前没有可单独展示的参与正文。</p>}{detail.nextAfter&&<button type="button" className="text-link" disabled={busy} onClick={()=>void readMore()}>更多依据</button>}</section>
   <details className="recognition-rule"><summary>查看完整规则范围</summary><dl><dt>发出方</dt><dd>{reading.issuer}</dd><dt>规则版本</dt><dd>{reading.version}</dd><dt>能力领域标识</dt><dd>{reading.capabilityId||'未提供'}</dd><dt>社区范围标识</dt><dd>{reading.communityId||'未提供'}</dd><dt>认可规则有效期</dt><dd>{date(reading.validFrom)} — {date(reading.validUntil)}</dd><dt>本次核对日期</dt><dd>{date(reading.checkedAt)}</dd>{reading.repositories.length>0&&<><dt>自动检查的仓库范围</dt><dd>{reading.repositories.join('、')}</dd></>}</dl></details>
  </>}
 </article>;
}
