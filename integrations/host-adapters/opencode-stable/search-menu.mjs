import { searchQuerySchema,searchScope,searchSourceTypes } from '../../../packages/galaxy-official/src/shared/search-schema.mjs';
import { createSearchFeedbackForm,createSearchFeedbackMenu } from './search-feedback-menu.mjs';
import { createProjectDiscoveryMenu } from './project-discovery-menu.mjs';

export function createSearchMenu({controller,select,prompt,info,language,isCurrent,onBack,onHistoryFilters,availableScopes=[]}){
  const zh=language!=='en-US',label=(cn,en)=>zh?cn:en;
  // oxlint-disable-next-line no-control-regex -- Prevent terminal controls in displayed user text.
  const plain=value=>String(value??'').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,6000);
  let generation=0;
  const alive=()=>isCurrent(),leave=()=>{generation++;controller.cancel();onBack();};
  function menu(title,entries,back=home){
    if(!alive())return;const version=++generation,routes={},options=entries.map(([title,action,description=''],i)=>{
      routes[i+1]=()=>{if(alive()&&version===generation)action();};return {number:String(i+1),title,description};});
    select({title,options,routes,onBack:()=>{if(alive()&&version===generation){generation++;back();}}});
  }
  const message=(text,back)=>{if(alive()){const version=++generation;info('Galaxy',text,()=>{if(alive()&&version===generation)back();});}};
  function edit(type,draft,field,title){
    const version=++generation;
    prompt({title,placeholder:draft[field]??'',onCancel:()=>{if(alive()&&version===generation)filters(type,draft);},onConfirm:value=>{
      if(!alive()||version!==generation)return;
      const next={...draft};if(value.trim())next[field]=value.trim();else delete next[field];
      if(!searchQuerySchema.safeParse({type,query:next}).success){message(label('筛选格式不正确，请修改。','Invalid filter; edit before searching.'),()=>filters(type,draft));return;}
      filters(type,next);
    }});
  }
  function filters(type,draft={query:'',limit:8}){
    const entries=[
      [label('关键词','Keywords'),()=>edit(type,draft,'query',type==='proof'?label('仓库、commit、run ID、CI结论或范围关键词','Repository, commit, run ID, CI conclusion or scope'):label('标题与问题关键词','Title and problem keywords')),plain(draft.query)],
      [label('开始查询','Search'),()=>query(type,draft),label('只查询当前选择的来源类型','Only the selected source type')]
    ];
    if(['worker','hub'].includes(type))entries.push([label('登记所有者 ID','Registry owner ID'),()=>edit(type,draft,'ownerId','Galaxy ID'),plain(draft.ownerId)]);
    else if(type!=='proof')entries.push(['Capability ID',()=>edit(type,draft,'capabilityId','Capability ID'),plain(draft.capabilityId)]);
    else entries.push([label('CI结论','CI conclusion'),()=>edit(type,draft,'conclusion','success / failure / neutral / cancelled / skipped / timed_out / action_required / stale / startup_failure'),plain(draft.conclusion)]);
    if(['case','history'].includes(type)&&onHistoryFilters)entries.push([label('完整履历筛选与反馈','Full History filters and feedback'),onHistoryFilters]);
    menu(`Galaxy / ${type}\n${label('来源类型保留；不是能力认证','Source types retained; not capability certification')}`,entries);
  }
  async function query(type,draft){
    const version=++generation;
    info('Galaxy',label('正在查询；Esc取消。','Searching; Esc cancels.'),()=>{if(alive()&&version===generation){generation++;controller.cancel();filters(type,draft);}});
    try{
      const page=await controller.querySearch({type,query:draft});if(!alive()||version!==generation)return;
      const render=()=>{
        const entries=page.items.map(item=>[`${item.type} · ${plain(item.title)}`,()=>message([
          `${item.type}: ${plain(item.id)}`,plain(item.summary),JSON.stringify(item.source,null,2),...item.matchReasons.map(plain),
          ...(item.limitations??[]).map(plain),JSON.stringify(item.record,null,2)
        ].join('\n'),()=>{
          if(!controller.recordSearchFeedback){render();return;}
          menu(label('查询结果操作','Search result actions'),[[label('填写本机反馈','Leave local feedback'),()=>{
            const current=++generation;createSearchFeedbackForm({select,info,language,isCurrent:()=>alive()&&current===generation,onBack:render,
              submit:verdict=>controller.recordSearchFeedback(item.id,verdict)}).open();
          }]],render);
        }),plain(item.summary)]);
        if(page.nextCursor)entries.push([label('下一页','Next page'),()=>query(type,{...draft,after:page.nextCursor})]);
        menu(`${type} · ${page.items.length}\n${page.windowLimited?label('已到扫描上限；可继续时请翻页，否则缩小条件。','Scan limit reached; continue if available, otherwise narrow filters.'):''}`,entries,()=>filters(type,{...draft,after:undefined}));
      };render();
    }catch(error){if(alive()&&version===generation)message(error.code==='GALAXY_RATE_LIMITED'
      ?label(`查询或连续翻页已达本轮限额，请在 ${error.retryAfterSeconds??60} 秒后重试。`,`Query or continuation limit reached; retry in ${error.retryAfterSeconds??60} seconds.`)
      :plain(error.message),()=>filters(type,draft));}
  }
  function home(){const entries=searchSourceTypes
    .filter(type=>availableScopes.includes(searchScope(type))).map(type=>[type,()=>filters(type)]);
    if (controller.queryProjectDiscovery && availableScopes.includes('history')) entries.push([label('项目／模块机会', 'Project / module opportunities'), () => {
      const current = ++generation;
      createProjectDiscoveryMenu({ controller, select, prompt, info, language, isCurrent: () => alive() && current === generation, onBack: home }).open();
    }]);
    if(controller.querySearchFeedback&&controller.editSearchFeedback)entries.push([label('本机反馈汇总','Local feedback summary'),()=>{
      const current=++generation;void createSearchFeedbackMenu({controller,select,info,language,isCurrent:()=>alive()&&current===generation,onBack:home}).open();
    }]);
    menu(label('选择检索来源','Choose search source'),entries,leave);
  }
  return Object.freeze({open:home});
}
