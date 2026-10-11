import { randomUUID } from 'node:crypto';
import { contextDraftSource,sameContextSource } from '../../../packages/galaxy-official/src/shared/context-draft.mjs';
export function createContextDraftMenu({controller,select,prompt,info,language,isCurrent,onBack,onConfirm,onOpenGrant,canSubmit=true}){
  const label=(a,b)=>language==='en-US'?b:a;
  const plain=value=>String(value??'').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,1200);
  let generation=0;const current=n=>isCurrent()&&generation===n;
  const kindName=kind=>kind==='grant'?label('分享选定材料','Share selected materials'):kind==='revoke'?label('结束材料授权','End material access'):plain(kind);
  const stateName=state=>({prepared:label('尚未确认完成','Completion not confirmed'),acknowledged:label('已完成','Completed'),unknown:label('暂未确认结果','Outcome unconfirmed'),absent:label('原材料尚未收到','Original materials not received')}[state]??plain(state));
  function menu(title,entries,back=onBack,offset=0){
    if(!isCurrent())return;const version=++generation,routes={};
    const once=fn=>()=>{if(current(version)){generation++;fn();}};
    const options=entries.slice(offset,offset+8).map(([title,action,description=''],index)=>{
      routes[index+1]=once(action);return {number:String(index+1),title,description};
    });
    if(offset+8<entries.length){options.push({number:'9',title:label('下一页','Next page')});routes[9]=once(()=>menu(title,entries,back,offset+8));}
    select({title,options,routes,onBack:once(offset?()=>menu(title,entries,back,Math.max(0,offset-8)):back)});
  }
  function message(text,back){
    if(!isCurrent())return;const version=++generation;info('Galaxy',text,()=>{if(current(version)){generation++;back();}});
  }
  async function run(work,done,back=onBack){
    if(!isCurrent())return;const version=++generation;
    info('Galaxy',label('正在保存或读取；Esc返回。','Saving or reading; Esc returns.'),()=>{if(current(version)){generation++;controller.cancel();back();}});
    try{const result=await work();if(current(version))done(result);}catch(error){if(current(version))message(plain(error.message),back);}
  }
  function save(row,changes){void run(()=>controller.saveContextDraft({id:row.id,expectedRevision:row.revision,content:{...row.content,...changes}}),render,()=>openDraft(row.id));}
  function selectFile(row,index=null){
    const back=()=>openDraft(row.id),version=++generation;
    prompt({title:label('选择本地文本或日志文件（绝对路径，最多8 MiB）','Choose a local text or log file (absolute path, up to 8 MiB)'),placeholder:'',
      onCancel:()=>{if(current(version)){generation++;back();}},onConfirm:value=>{
        if(!current(version))return;generation++;selectLines(String(value).trim());
      }});
    function selectLines(path){
      const version=++generation;
      prompt({title:label('选择起止行号（含两端，最多200行、4000字符），如12-24','Select inclusive line numbers (up to 200 lines, 4000 characters), e.g. 12-24'),placeholder:'12-24',
        onCancel:()=>{if(current(version)){generation++;back();}},onConfirm:value=>{
          if(!current(version))return;generation++;
          const range=/^([1-9]\d*)\s*-\s*([1-9]\d*)$/.exec(String(value).trim());
          if(!range)return message(label('请输入起始行-结束行，例如12-24；单行可写12-12。','Enter start-end, e.g. 12-24; use 12-12 for one line.'),()=>selectLines(path));
          void run(()=>controller.previewContextFile({id:row.id,expectedRevision:row.revision,path,startLine:Number(range[1]),endLine:Number(range[2])}),selection=>{
            const summary=`${label('本地文件片段预览','Local file excerpt preview')}\n${selection.path}\n${selection.startLine}-${selection.endLine} / ${selection.totalLines}\n${label('材料名称','Material label')}: ${selection.label}`;
            message(`${summary}\n\n${selection.content}\n\n${label('确认加入后仅保存名称和上述文本；绝对路径不保存。文件后续变化不会自动更新这份片段。','Adding saves only the label and text above, without the absolute path. Later file changes do not update this excerpt.')}`,()=>menu(summary,[
              [label('加入本地草稿','Add to local draft'),()=>{
                const material={id:index===null?randomUUID():row.content.materials[index].id,label:selection.label,content:selection.content};
                const materials=index===null?[...row.content.materials,material]:row.content.materials.map((item,i)=>i===index?material:item);
                save(row,{materials,step:'overview',index:index??materials.length-1});
              }],
              [label('重新选择行号','Choose another line range'),()=>selectLines(path)],
              [label('取消导入','Cancel import'),back],
            ],back));
          },back);
        }});
    }
  }
  function edit(row){
    const c=row.content,item=c.materials[c.index],key=c.step==='expiry'?'hours':c.step;
    const title=key==='hours'?label('有效小时数（大于0，最多24）','Validity hours (over 0, at most 24)'):
      key==='label'?label('材料名称','Material label'):label('选定文本片段（最多4000字符）','Selected text excerpt (up to 4000 characters)');
    const initial=key==='hours'?c.hours:item[key],version=++generation;
    prompt({title:`${title}\n${label('确认后仅存本机；留空保留原值，/clear清空。不要包含凭据或完整会话。','Saved locally on confirmation; empty keeps the value, /clear removes it. Exclude credentials and full sessions.')}`,
      placeholder:initial,onCancel:()=>{if(current(version)){generation++;save(row,{step:'overview'});}},
      onConfirm:value=>{
        if(!current(version))return;generation++;
        const raw=String(value),text=raw==='/clear'?'':raw||initial;
        if(key==='hours'){
          const hours=Number(text);if(!Number.isFinite(hours)||hours<=0||hours>24)return message(label('有效期必须大于0且不超过24小时。','Validity must be over 0 and at most 24 hours.'),()=>render(row));
          return save(row,{hours:text,step:'overview'});
        }
        save(row,{materials:c.materials.map((material,index)=>index===c.index?{...material,[key]:text}:material),step:key==='label'?'content':'overview'});
      }});
  }
  function render(row){
    if(!isCurrent())return;if(row.status!=='editing')return operation(row.id);
    const c=row.content,back=()=>openDraft(row.id);
    if(c.step!=='overview')return edit(row);
    menu(`${label('选定材料草稿','Selected material draft')}\n${plain(c.source.title)}\n${label('接收方','Recipient')}: ${plain(c.source.participantId)}\n${label('范围','Scope')}: ${plain(c.source.scope)}\n${c.materials.length}/8 · ${c.hours} h`,[
      ...c.materials.map((item,index)=>[plain(item.label)||label('未命名片段','Untitled excerpt'),()=>menu(plain(item.label)||'Context',[
        [label('编辑片段','Edit excerpt'),()=>save(row,{step:'label',index})],
        [label('查看本地文本','View local text'),()=>message(item.content,()=>render(row))],
        ...(controller.previewContextFile?[[label('从文件或日志替换片段','Replace from a file or log'),()=>selectFile(row,index)]]:[]),
        ...(c.materials.length>1?[[label('移除此片段','Remove excerpt'),()=>save(row,{materials:c.materials.filter((_,i)=>i!==index),index:0})]]:[]),
      ],()=>render(row)),label('本地保存','Saved locally')]),
      ...(c.materials.length<8?[[label('添加选定片段','Add selected excerpt'),()=>save(row,{materials:[...c.materials,{id:randomUUID(),label:'',content:''}],index:c.materials.length,step:'label'})]]:[]),
      ...(c.materials.length<8&&controller.previewContextFile?[[label('添加文件或日志片段','Add a file or log excerpt'),()=>selectFile(row)]]:[]),
      [label('修改有效期','Edit validity'),()=>save(row,{step:'expiry'})],
      ...(canSubmit?[[label('预览接收方、范围和材料','Preview recipient, scope and materials'),()=>checkSource(row,submit)]]:[]),
      [label('留待以后继续','Continue later'),open],
    ],back);
  }
  function checkSource(row,done){
    const back=()=>openDraft(row.id);
    void run(()=>controller.getAssistance(row.content.source.assistanceId),record=>{
      let source;try{source=contextDraftSource(record);}catch(error){return message(plain(error.message),back);}
      if(sameContextSource(row.content.source,source))return done(row);
      const previous=row.content.source;
      menu(`${label('材料接收方或范围选择已变化；原材料仍保存在本机。','Recipient or scope selection changed; original materials remain local.')}\n${label('原接收方与范围','Saved recipient and scope')}:\n${plain(previous.participantId)}\n${plain(previous.scope)}\n${label('当前接收方与范围','Current recipient and scope')}:\n${plain(source.participantId)}\n${plain(source.scope)}`,[
        [label('确认当前接收方和范围，重新审阅','Use current recipient and scope, then review'),()=>void run(()=>controller.rebaseContextDraft({id:row.id,expectedRevision:row.revision,record}),render,back)],
        [label('查看原选择与当前来源','Inspect original choice and current source'),()=>message(JSON.stringify({previous,current:source},null,2),()=>checkSource(row,done))],
        [label('返回保留原草稿','Keep original draft'),back],
      ],back);
    },back);
  }
  function submit(row){generation++;onConfirm({kind:'grant',assistanceId:row.content.source.assistanceId,draftId:row.id,draftRevision:row.revision},()=>openDraft(row.id));}
  function openDraft(id){void run(()=>controller.getContextDraft(id),row=>{
    if(row.status!=='editing')return operation(row.id);
    menu(plain(row.content.source.title),[
      [label('继续编辑材料','Continue editing materials'),()=>canSubmit?checkSource(row,render):render(row)],
      [label('删除本地材料草稿','Remove local material draft'),()=>void run(()=>controller.forgetContextDraft(id),open)],
    ],open);
  },open);}
  function operation(eventId){void run(async()=>{const page=await controller.listContextOperations(),row=page.items.find(item=>item.eventId===eventId);
    let result,readError;if(row&&canSubmit&&controller.reconcileContext){try{result=await controller.reconcileContext(eventId);}catch(error){readError=plain(error.message);}}
    return{row,result,readError};},({row,result,readError})=>{
    if(!row)return message(label('本地记录不存在。','Local record unavailable.'),open);
    const back=()=>operation(eventId);
    menu(`${kindName(row.kind)} · ${stateName(result?.state??row.status)}${readError?'\n'+label('暂未取得当前结果；原材料已保留。','Current outcome unavailable; original materials retained.'):''}`,[
      ...(controller.getLocalContextOperation?[[label('查看本地已确认内容','View locally prepared content'),()=>void run(()=>controller.getLocalContextOperation(eventId),
        saved=>{let payload;try{payload=JSON.parse(saved?.payloadJson??'null');}catch{/* Exact bytes remain available in source details. */}
          message(payload?.materials?.map(item=>plain(item.label)+'\n'+String(item.content??'')).join('\n\n')||label('这条本地记录没有材料正文。','This local record has no material text.'),back);},back)],
        [label('查看原材料与签署来源','Inspect original materials and signed source'),()=>void run(()=>controller.getLocalContextOperation(eventId),saved=>message(saved?.payloadJson??label('本地记录不存在。','Local record unavailable.'),back),back)]]:[]),
      ...(canSubmit?[
        ...(readError?[[label('重试读取','Retry reading'),back]]:[]),
        ...(result?.state==='absent'?[[label('预览原材料操作并重试','Preview original material operation and retry'),()=>{generation++;onConfirm(eventId,back,true);}]]:[]),
        [label('读取当前材料授权','Read current material grant'),()=>{generation++;onOpenGrant(row.grantId,row.kind==='grant');}]
      ]:[]),
      ...(['prepared','acknowledged'].includes(row.status)?[[label('删除本地提交记录','Remove local submission record'),()=>void run(()=>controller.forgetContextOperation(eventId),open,back)]]:[]),
    ],open);
  },open);}
  function open(){void run(async()=>({drafts:await controller.listContextDrafts(),operations:await controller.listContextOperations()}),({drafts,operations})=>menu(
    label('本地材料草稿与已分享内容','Local material drafts and shared content'),[
      ...drafts.items.filter(row=>row.status==='editing').map(row=>[plain(row.title),()=>openDraft(row.id),plain(row.updatedAt)]),
      ...operations.items.map(row=>[`${kindName(row.kind)} · ${stateName(row.status)}`,()=>operation(row.eventId),plain(row.updatedAt)]),
    ]));}
  function create(record){void run(()=>controller.createContextDraft(record),row=>controller.previewContextFile?menu(label('选择材料来源','Choose material source'),[
    [label('粘贴文本片段','Paste a text excerpt'),()=>render(row)],
    [label('选择文件或日志片段','Select a file or log excerpt'),()=>selectFile(row,0)],
  ],()=>openDraft(row.id)):render(row));}
  return Object.freeze({open,create,openDraft});
}
