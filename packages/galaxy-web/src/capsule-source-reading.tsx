import type {CapsuleDetail} from './capsule-authoring-types';

const outcomeLabels:Record<string,string>={succeeded:'作者报告：达到这条结果的目标',partial:'作者报告：部分达到目标',failed:'作者报告：未达到目标',inconclusive:'作者报告：尚无定论',conflicting:'作者报告：结论有冲突'};
const subjectPattern=/^GUID[0-9A-Z]{28}$/;
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function CapsuleSourceReading({reading,navigate}:{reading:CapsuleDetail['sourceReading'];navigate:(path:string)=>void}){
 if(!reading)return <p className="source-reading-note">这份历史方法没有可读的来源摘要，准确引用保留在下方。</p>;
 const source=reading.case,result=reading.result;
 const path=source.status==='available'&&source.ref&&source.authorId&&subjectPattern.test(source.authorId)&&uuidPattern.test(source.ref.id)
  ?'/app/people/'+source.authorId+'?section=experience&record='+encodeURIComponent('case:'+source.ref.id):null;
 return <div className="method-source-context">
  <div className="method-source-background"><h3>{source.status==='available'&&source.title?source.title:'原工作'}</h3>
   {source.status==='available'?<>{source.summary&&<p className="reading-prose">{source.summary}</p>}{path&&<a href={path} className="text-link" onClick={event=>{event.preventDefault();navigate(path);}}>查看当前可读的原工作 →</a>}</>:<p className="source-reading-note">当前无法读取这份原工作资料。</p>}
  </div>
  <div className="method-source-result"><h3>这一版方法依据的结果</h3>
   {result.status==='available'?<>
    <p className="method-source-result-meta">第 {result.ref.version} 版结果{result.reportedOutcome&&outcomeLabels[result.reportedOutcome]?' · '+outcomeLabels[result.reportedOutcome]:''}</p>
    {result.summary&&<p className="reading-prose">{result.summary}</p>}
    {result.limitations&&<p className="reading-prose method-source-boundary"><strong>这条结果的范围与限制</strong>{result.limitations}</p>}
   </>:<p className="source-reading-note">当前无法读取这条结果的正文，未用其他版本代替。</p>}
  </div>
 </div>;
}
