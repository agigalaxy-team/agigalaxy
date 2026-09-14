import { searchSourceTypes } from '../../../packages/galaxy-official/src/shared/search-schema.mjs';
const plain=value=>String(value??'').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,6000);
function surface({select,info,language,isCurrent,onBack}){
  const label=(cn,en)=>language==='en-US'?en:cn;let generation=0;
  const current=()=>isCurrent();
  const begin=()=>{const version=++generation;return ()=>current()&&version===generation;};
  function menu(title,entries,back=onBack){
    if(!current())return;const valid=begin(),routes={},options=entries.map(([title,action,description=''],i)=>{
      routes[i+1]=()=>{if(valid())action();};return {number:String(i+1),title,description};});
    select({title,options,routes,onBack:()=>{if(valid()){generation++;back();}}});
  }
  function message(text,back=onBack){if(current()){const valid=begin();info('Galaxy',text,()=>{if(valid()){generation++;back();}});}}
  return {label,begin,menu,message};
}

export function createSearchFeedbackForm(options){
  const {submit,onBack}=options,{label,begin,menu,message}=surface(options);
  let verdict={...(options.initial??{relevance:'unsure',helpedSelection:null})};
  const relevant={relevant:label('相关','Relevant'),'not-relevant':label('不相关','Not relevant'),unsure:label('不确定','Unsure')};
  const helped=value=>value===null?label('未回答','Unanswered'):value?label('有帮助','Helpful'):label('没有帮助','Not helpful');
  async function save(value){
    const valid=begin();
    try{await submit(value);if(valid())message(label('本机反馈已更新。','Local feedback updated.'),onBack);}
    catch(error){if(valid())message(plain(error.message),onBack);}
  }
  function home(){menu(label('我的查询反馈（仅保存在本机）','My search feedback (local only)'),[
    [label('是否相关','Relevance'),()=>menu(label('是否相关','Relevance'),Object.entries(relevant).map(([value,title])=>[title,()=>{verdict.relevance=value;home();}]),home),relevant[verdict.relevance]],
    [label('是否帮助选择','Helped selection'),()=>menu(label('是否帮助选择','Helped selection'),[true,false,null].map(value=>[helped(value),()=>{verdict.helpedSelection=value;home();}]),home),helped(verdict.helpedSelection)],
    [label('保存反馈','Save feedback'),()=>save({...verdict}),label('个人意见，与任务结果和能力验证分开','Personal opinion, separate from task outcomes and verification')],
    [label('移除此条反馈','Remove this feedback'),()=>save(null)]
  ]);}
  return Object.freeze({open:home});
}

export function createSearchFeedbackMenu(options){
  const {controller,onBack}=options,{label,begin,menu,message}=surface(options);
  const summaryText=summary=>[
    label(`本机反馈 ${summary.responses} 条 · ${summary.sources} 个来源 · ${summary.queries} 组条件`,`${summary.responses} local responses · ${summary.sources} sources · ${summary.queries} queries`),
    label(`相关 ${summary.relevance.relevant} / 不相关 ${summary.relevance.notRelevant} / 不确定 ${summary.relevance.unsure}`,`Relevant ${summary.relevance.relevant} / not relevant ${summary.relevance.notRelevant} / unsure ${summary.relevance.unsure}`),
    label(`帮助选择 ${summary.helpedSelection.yes} / 没有帮助 ${summary.helpedSelection.no} / 未回答 ${summary.helpedSelection.unanswered}`,`Helpful ${summary.helpedSelection.yes} / not helpful ${summary.helpedSelection.no} / unanswered ${summary.helpedSelection.unanswered}`),
    label('仅当前本机身份及所选端点的主动意见；不是成功率。','Opinions of this local identity for the selected endpoint; not a success rate.'),
    ...(summary.unreadableEntries?[label(`${summary.unreadableEntries} 条记录格式无法读取，未纳入统计。`,`${summary.unreadableEntries} unreadable entries excluded.`)]:[])
  ].join('\n');
  async function home(){
    const valid=begin();
    try{
      const page=await controller.querySearchFeedback({limit:1});if(!valid())return;
      menu(`${label('本机反馈汇总','Local feedback summary')}\n${plain(page.endpoint)}\n${summaryText(page.summary)}`,
        [[label('全部反馈','All feedback'),()=>browse()],...searchSourceTypes.map(type=>[type,()=>browse({sourceType:type}),String(page.summary.bySource[type]?.responses??0)])],onBack);
    }catch(error){if(valid())message(plain(error.message),onBack);}
  }
  async function browse(selection={}){
    const valid=begin();
    try{
      const page=await controller.querySearchFeedback({...selection,limit:8});if(!valid())return;
      const back=()=>browse(selection),entries=page.items.map(row=>[
        `${row.sourceType} · ${plain(row.criteria.query)||label('无关键词','No keywords')}`,
        ()=>message([`${row.sourceType}: ${row.sourceId}`,`${label('来源版本','Source version')}: ${row.sourceVersion}`,
          `${label('来源摘要','Source hash')}: ${row.snapshotHash}`,`${label('更新时间','Updated')}: ${row.updatedAt}`,
          JSON.stringify(row.criteria,null,2),`${row.relevance} · ${String(row.helpedSelection)}`,
          label('这是个人反馈记录；来源当前有效性未重新核查。','Personal feedback record; current source validity has not been rechecked.')].join('\n'),()=>{
            const current=begin();createSearchFeedbackForm({...options,isCurrent:current,onBack:back,
              initial:{relevance:row.relevance,helpedSelection:row.helpedSelection},
              submit:verdict=>controller.editSearchFeedback({id:row.id,revision:row.revision,verdict})}).open();
          }),`${row.relevance} · ${plain(row.sourceId)}`]);
      if(page.nextCursor)entries.push([label('下一页','Next page'),()=>browse({...selection,after:page.nextCursor})]);
      menu(`${label('本机反馈','Local feedback')} · ${selection.sourceType??label('全部','All')}\n${summaryText(page.summary)}\n${page.items.length? '':label('本页没有反馈。','No feedback on this page.')}`,entries,home);
    }catch(error){if(valid())message(plain(error.message),home);}
  }
  return Object.freeze({open:home});
}
