// The legacy controllers still consume v1 facts. Read current v1 projections
// for the same connected subject; none of these choices migrate a fact to v2.
export function createLegacyWorkSelection({controller,menu,form,message,run,label,plain,readWorkContext}){
 const outcome=v=>({succeeded:label('完成','Completed'),partial:label('部分完成','Partial'),failed:label('未完成','Failed'),inconclusive:label('暂不能得出结论','Inconclusive'),conflicting:label('观察有冲突','Conflicting')}[v]??plain(v));
 function select(done,back,{mode='case',resultFilter=()=>true,excludeCaseId,preferredCaseId,requiredCaseId,subjectId:selectedSubject,query='',after,visited=0}={}){
  if(!controller.queryHistory)return message(label('当前连接没有可见履历读取，无法选择已有来源。可在连接设置按需要接续读取。','This connection has no visible history reader. Select the necessary history access in connection settings.'),back);
  void run(async()=>{const status=await controller.status?.(),context=await readWorkContext?.(),subjectId=selectedSubject??status?.subjectId;
   const page=await controller.queryHistory({query,limit:7,...(subjectId?{subjectId}:{}),...(after?{after}:{})});return{page,subjectId,preferredCaseId:preferredCaseId??context?.caseId};
  },({page,subjectId,preferredCaseId:preferred})=>{
   const rows=(page.items??[]).filter(r=>(!requiredCaseId||r.caseId===requiredCaseId)&&r.caseId!==excludeCaseId&&r.state!=='withdrawn'&&(mode==='case'||mode==='attempt'&&(r.attempts??[]).length||mode==='result'&&(r.results??[]).some(resultFilter)));
   if(requiredCaseId&&!rows.length){if(page.nextCursor&&visited<64)return select(done,back,{mode,resultFilter,excludeCaseId,requiredCaseId,subjectId:selectedSubject,query,after:page.nextCursor,visited:visited+1});return message(label('对应的当前工作或结果暂不可读。请继续原工作，或重新取得当前允许的来源。','The corresponding work or result is unavailable. Continue it or read its currently permitted source.'),back);}
   const choose=row=>{const work={...row,locator:{query,after,subjectId}};
    if(mode==='case')return done(work);
    const entries=mode==='attempt'?(row.attempts??[]):(row.results??[]).filter(resultFilter),picked=item=>done({...work,...(mode==='attempt'?{attempt:item}:{result:item})});
    if(entries.length===1)return picked(entries[0]);menu(plain(row.title),entries.map(v=>[mode==='attempt'?plain(v.approach)||label('原工作中的尝试 ','Attempt in this work ')+plain(v.sequence):plain(v.summary)||outcome(v.outcome),()=>picked(v),mode==='result'?outcome(v.outcome):'']),back);
   };
   const preferredRow=rows.find(r=>r.caseId===preferred);if(preferredRow)return choose(preferredRow);
   const entries=rows.map(r=>[plain(r.title),()=>choose(r),plain(r.summary,240)]);
   if(page.nextCursor)entries.push([label('其他已有工作','Other existing work'),()=>select(done,back,{mode,resultFilter,excludeCaseId,preferredCaseId,requiredCaseId,subjectId:selectedSubject,query,after:page.nextCursor})]);
   entries.push([label('按目标查找','Find by goal'),()=>form(label('查找已有工作','Find existing work'),[['query',label('工作标题或目标中的文字','Words in the title or goal'),query,200]],v=>select(done,back,{mode,resultFilter,excludeCaseId,preferredCaseId,requiredCaseId,subjectId:selectedSubject,query:v.query}),back)]);
   menu(label('选择已有工作','Choose existing work')+(!rows.length?'\n'+label('这一页没有符合本次用途的当前来源。','This page has no current source for this purpose.') : ''),entries,back);
  },back);
 }
 async function reread(work){const q=work.locator??{},page=await controller.queryHistory({query:q.query??'',limit:7,...(q.subjectId?{subjectId:q.subjectId}:{}),...(q.after?{after:q.after}:{})}),row=page.items?.find(r=>r.caseId===work.caseId&&r.state!=='withdrawn');
  if(!row||work.result&&!row.results?.some(r=>r.id===work.result.id&&r.attemptId===work.result.attemptId)||work.attempt&&!row.attempts?.some(a=>a.id===work.attempt.id))throw Error(label('所选来源已不可读，请重新选择当前允许的工作。','The selected source is unavailable. Choose currently permitted work.'));
  return{...row,locator:q,...(work.result?{result:row.results.find(r=>r.id===work.result.id)}:{}),...(work.attempt?{attempt:row.attempts.find(a=>a.id===work.attempt.id)}:{})};
 }
 function proofs(work,done,back,{required=false,initial=[]}={}){const conclusion=v=>({success:label('运行成功','Run succeeded'),failure:label('运行失败','Run failed'),neutral:label('中性结果','Neutral result'),cancelled:label('已取消','Canceled'),skipped:label('已跳过','Skipped'),timed_out:label('已超时','Timed out'),action_required:label('需要处理','Action required'),stale:label('记录已过时','Stale result'),startup_failure:label('启动失败','Startup failed')}[v]??plain(v));
  const available=(work.proofs??[]).filter(p=>p.status==='active'),titles=p=>{const s=p.provenance?.source??{};return[s.repository,s.runId?label('运行 ','Run ')+s.runId:'',s.attempt?label('尝试 ','Attempt ')+s.attempt:'',p.provenance?.conclusion?conclusion(p.provenance.conclusion):''].filter(Boolean).map(v=>plain(v,160)).join(' · ')||label('当前可读的 CI 来源','Current readable CI source');};
  if(!available.length){if(required)return message(label('这次结果没有当前可读的 CI 来源。请继续原工作或选择其他结果。','This result has no current readable CI source. Continue the work or choose another result.'),back);return done([]);}
  const show=chosen=>{const entries=available.filter(p=>!chosen.includes(p.proofId)).map(p=>[titles(p),()=>show([...chosen,p.proofId])]);
   if(chosen.length>=16)entries.length=0;
   if(chosen.length)entries.unshift([label('使用所选来源','Use selected sources'),()=>void run(async()=>{const fresh=await reread(work);if(chosen.some(id=>!fresh.proofs?.some(p=>p.proofId===id&&p.status==='active')))throw Error(label('所选来源已不可读','Selected sources unavailable'));return chosen;},done,back),chosen.map(id=>titles(available.find(p=>p.proofId===id))).join('\n')]);
   if(!required)entries.push([label('此次不引用 CI 来源','Do not cite CI sources this time'),()=>done([])]);
   entries.push([label('查看来源详情','Inspect source details'),()=>message(JSON.stringify(available.map(p=>p.provenance??p),null,2),()=>show(chosen))]);
   menu(label('选择这次结果的来源','Choose sources for this result')+'\n'+plain(work.result?.summary),entries,back);
  };show(initial.filter(id=>available.some(p=>p.proofId===id)));
 }
 return{select,reread,proofs,outcome};
}
