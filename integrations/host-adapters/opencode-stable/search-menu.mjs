import { searchQuerySchema,searchScope,searchSourceTypes } from '../../../packages/galaxy-contracts/src/search-schema.mjs';
import { createSearchFeedbackForm,createSearchFeedbackMenu } from './search-feedback-menu.mjs';
import { createProjectDiscoveryMenu } from './project-discovery-menu.mjs';
import {createCapsuleMenu} from './capsule-menu.mjs';
import {createBuilderMenu} from './builder-menu.mjs';
import {searchSourceName,sourceReadingText} from './source-reading.mjs';

export function createSearchMenu({controller,select,prompt,info,language,isCurrent,onBack,onHistoryFilters,availableScopes=[],nativeCall=null,onReturnWork=onBack,onOpenRoom=null,openLink=null,readWorkContext=/** @type {null|(()=>Promise<{origin?:{host:string;workRef:string};caseId?:string;taskId?:string;a2a?:{peerId:string;attemptId:string;attemptVersion:number;text:string}}|null>)} */(null)}){
  const zh=language!=='en-US',label=(cn,en)=>zh?cn:en;
  // oxlint-disable-next-line no-control-regex -- Prevent terminal controls in displayed user text.
  const plain=value=>String(value??'').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,6000);
  let generation=0;
  const alive=()=>isCurrent(),leave=()=>{generation++;controller.cancel();onBack();};
  function menu(title,entries,back=home,offset=0){
    if(!alive())return;const version=++generation,routes={},activate=fn=>()=>{if(alive()&&version===generation){generation++;fn();}},options=entries.slice(offset,offset+8).map(([title,action,description=''],i)=>{
      routes[i+1]=activate(action);return {number:String(i+1),title,description};});
    if(offset+8<entries.length){options.push({number:'9',title:label('继续查看','More content'),description:''});routes[9]=activate(()=>menu(title,entries,back,offset+8));}
    select({title,options,routes,onBack:activate(offset?()=>menu(title,entries,back,offset-8):back)});
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
    if(['worker','hub'].includes(type))entries.push([label('限定某位所有者（可选）','Limit to an owner (optional)'),()=>edit(type,draft,'ownerId',label('已有所有者的稳定身份','Existing owner stable identity')),plain(draft.ownerId)]);
    else if(type!=='proof')entries.push([label('限定能力分类（可选）','Limit capability category (optional)'),()=>edit(type,draft,'capabilityId',label('已有能力分类标识','Existing capability category')),plain(draft.capabilityId)]);
    else entries.push([label('CI结论','CI conclusion'),()=>edit(type,draft,'conclusion','success / failure / neutral / cancelled / skipped / timed_out / action_required / stale / startup_failure'),plain(draft.conclusion)]);
    if(['case','history'].includes(type)&&onHistoryFilters)entries.push([label('完整履历筛选与反馈','Full History filters and feedback'),onHistoryFilters]);
    menu(label('查找','Find ')+searchSourceName(type,label),entries);
  }
  async function query(type,draft){
    const version=++generation;
    info('Galaxy',label('正在查询；Esc取消。','Searching; Esc cancels.'),()=>{if(alive()&&version===generation){generation++;controller.cancel();filters(type,draft);}});
    try{
      const page=await controller.querySearch({type,query:draft});if(!alive()||version!==generation)return;
      const render=()=>{
        const entries=page.items.map(item=>[plain(item.title),()=>readResult(item,type,draft,render),plain(item.summary)]);
        if(page.nextCursor)entries.push([label('下一页','Next page'),()=>query(type,{...draft,after:page.nextCursor})]);
        menu(`${searchSourceName(type,label)} · ${page.items.length}\n${page.windowLimited?label('已到扫描上限；可继续时请翻页，否则缩小条件。','Scan limit reached; continue if available, otherwise narrow filters.'):''}`,entries,()=>filters(type,{...draft,after:undefined}));
      };render();
    }catch(error){if(alive()&&version===generation)message(error.code==='GALAXY_RATE_LIMITED'
      ?label(`查询或连续翻页已达本轮限额，请在 ${error.retryAfterSeconds??60} 秒后重试。`,`Query or continuation limit reached; retry in ${error.retryAfterSeconds??60} seconds.`)
      :plain(error.message),()=>filters(type,draft));}
  }
  async function readResult(item,type,draft,back){const version=++generation;
    info('Galaxy',label('正在读取当前内容','Reading current content'),()=>{if(alive()&&version===generation){generation++;controller.cancel();back();}});
    try{const page=await controller.querySearch({type,query:draft});if(!alive()||version!==generation)return;
      const fresh=page.items.find(value=>value.id===item.id);if(!fresh)return message(label('原来源已变化或不可读。请返回选择当前结果。','The original source changed or is unavailable. Return to choose a current result.'),()=>query(type,draft));
      const show=()=>menu(plain(fresh.title),[
        [label('阅读全文','Read full content'),()=>readResult(fresh,type,draft,back)],
        ...(type==='capsule'&&controller.getCapsule?[[label('打开方法正文与使用','Open method and use'),()=>{const current=++generation;createCapsuleMenu({controller,select,prompt,info,language,isCurrent:()=>alive()&&current===generation,onBack:show,onReturnWork,readWorkContext,availableScopes}).openCapsule(fresh.id,fresh.source?.versionId);}]]:[]),
        ...(['worker','hub'].includes(type)&&controller.getBuilder?[[label('查看当前节点与接续能力','Read current node and connection'),()=>{const current=++generation;createBuilderMenu({controller,select,prompt,info,language,isCurrent:()=>alive()&&current===generation,onBack:show,onReturnWork,availableScopes}).openBuilder(fresh.id);}]]:[]),
        [label('查看来源详情','Inspect source details'),()=>message(JSON.stringify(fresh,null,2),show)],
        ...(controller.recordSearchFeedback?[[label('填写本机反馈','Leave local feedback'),()=>void feedback(fresh,type,draft,back)]]:[]),
        [label('继续选择','Continue choosing'),back]
      ],back);info(plain(fresh.title),sourceReadingText(fresh,label,plain),()=>{if(alive()&&version===generation)show();});
    }catch(error){if(alive()&&version===generation)message(plain(error.message),()=>query(type,draft));}
  }
  async function feedback(item,type,draft,back){const version=++generation;
    info('Galaxy',label('正在读取当前来源','Reading the current source'),()=>{if(alive()&&version===generation){generation++;controller.cancel();back();}});
    try{const current=await controller.querySearch({type,query:draft});if(!alive()||version!==generation)return;
      if(!current.items.some(value=>value.id===item.id))return message(label('原来源已变化或不可读。请返回选择当前结果。','The original source changed or is unavailable. Return to choose a current result.'),()=>query(type,draft));
      createSearchFeedbackForm({select,info,language,isCurrent:()=>alive()&&version===generation,onBack:back,submit:verdict=>controller.recordSearchFeedback(item.id,verdict)}).open();
    }catch(error){if(alive()&&version===generation)message(plain(error.message),()=>query(type,draft));}
  }
  function home(){const entries=searchSourceTypes
    .filter(type=>availableScopes.includes(searchScope(type))).map(type=>[searchSourceName(type,label),()=>filters(type)]);
    if ((nativeCall||controller.queryProjectDiscovery) && availableScopes.includes('history')) entries.push([label('寻找同行', 'Find people and projects'), () => {
      const current = ++generation;
      createProjectDiscoveryMenu({ controller,nativeCall,onReturnWork,onOpenRoom,openLink,readWorkContext,select, prompt, info, language, isCurrent: () => alive() && current === generation, onBack: home }).open();
    }]);
    if(controller.querySearchFeedback&&controller.editSearchFeedback)entries.push([label('本机反馈汇总','Local feedback summary'),()=>{
      const current=++generation;void createSearchFeedbackMenu({controller,select,info,language,isCurrent:()=>alive()&&current===generation,onBack:home}).open();
    }]);
    menu(label('选择检索来源','Choose search source'),entries,leave);
  }
  return Object.freeze({open:home});
}
