export function createDeletionMenu({ controller, select, prompt, info, language, isCurrent, onBack, onReturnWork=onBack, canSubmit = true, records = /** @type {ReturnType<import('../local-deletion-records.mjs').createLocalDeletionRecords>|null} */ (null) }) {
  const zh = language !== 'en-US', label = (a,b) => zh ? a : b;
  const plain = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,1000);
  const names = { requested: ['已申请','Requested'], 'review-needed': ['待补充信息','Information needed'], approved: ['已审核，尚未执行','Approved; not executed'], rejected: ['未获通过','Declined'], cancelled: ['已取消','Cancelled'] };
  const stateName = state => names[state] ? label(...names[state]) : plain(state);
  names.partial=['部分数据待处理','Some data remains'];names['primary-erased']=['主库本人数据已删除','Owned primary data erased'];
  const executionText = result => result.execution
    ? `${label('本次删除记录数','Rows deleted this run')}: ${Object.values(result.execution.deletedCounts).reduce((a,b)=>a+Number(b),0)}\n${label('待处理记录数','Remaining rows')}: ${Object.values(result.execution.remainingCounts).reduce((a,b)=>a+Number(b),0)}\n${label('审计记录状态','Audit state')}: ${plain(result.execution.audit.state)}\n${label('备份删除和到期处理尚未确认；不能视为全部删除完成','Backup deletion and expiry are unverified; service-wide deletion is incomplete')}`
    : label('尚未物理删除数据','Data has not been physically deleted');
  let generation = 0, view = 0, timer = null;
  const stop = () => { clearTimeout(timer); timer=null; view++; };
  const back = () => { stop();generation++; controller.cancel(); onBack(); };
  const returnWork = () => { stop();generation++; controller.cancel(); onReturnWork(); };
  async function run(work, done) {
    stop();const version = ++generation;
    info(label('数据删除申请','Data deletion request'),label('正在处理','Working'),back);
    try { const value = await work(); if (version === generation && isCurrent()) done(value); }
    catch(error) { if (version === generation && isCurrent()) info(label('操作未完成','Operation incomplete'),plain(error.message),home); }
  }
  function preview(input) {
    void run(() => controller.prepareDeletion(input), value => {
      const intent = JSON.parse(value.payloadJson);
      let submitted=false;
      const title=intent.action==='cancel'?label('取消这次申请','Cancel this request'):label('申请删除本人资料','Request deletion of my data');
      const scopeText=intent.action==='cancel'?label('取消尚未执行的申请','Cancel a request that has not been executed'):
        label(`范围：全部本人云端数据。${intent.takeout==='already-exported'?'已自行取回所需资料。':'不需要先导出。'}本次提交申请，不立即擦除数据。`,
          `Scope: all owned service data. ${intent.takeout==='already-exported'?'Needed data exported.':'Export not needed.'} Submission does not immediately erase data.`);
      const show=()=>{const current=++view;select({ title,
        options: [{ number:'1',title:intent.action==='cancel'?label('取消申请','Cancel request'):label('提交申请','Submit request'),description:
          scopeText},
          {number:'2',title:label('返回','Back'),description:''},
          {number:'3',title:label('查看申请范围与来源','Inspect request scope and source'),description:label('服务：','Service: ')+plain(value.endpoint)}],
        routes: { 1: () => {if(submitted||current!==view||!isCurrent())return;submitted=true;void run(async () => {await records?.rememberPreview(value);const result=await controller.executeDeletion(value,value.confirmation);await records?.observe(result).catch(()=>{});return result;}, result => details(result.id));},
          2: () => { if(current!==view)return;submitted=true;controller.cancel(); home(); },
          3:()=>{if(submitted||current!==view||!isCurrent())return;const detail=++view;info(label('原申请与签署内容','Original request and signed content'),value.payloadJson,()=>{if(!submitted&&detail===view&&isCurrent())show();});}
        }, onBack: () => { if(current!==view)return;submitted=true;controller.cancel(); home(); } });};
      const reading=++view;
      info(title,scopeText+'\n\n'+label('服务：','Service: ')+plain(value.endpoint),()=>{if(isCurrent()&&!submitted&&reading===view)show();});
    });
  }
  function create() {
    select({ title:label('申请前的数据取回','Data takeout before requesting deletion'),
      options:[{number:'1',title:label('我已取回所需数据','I exported the data I need'),description:''},
        {number:'2',title:label('我不需要先导出','I do not need an export'),description:''}],
      routes:{1:()=>preview({action:'request',scope:'all-owned-service-data',reason:'account-exit',takeout:'already-exported'}),
        2:()=>preview({action:'request',scope:'all-owned-service-data',reason:'account-exit',takeout:'not-needed'})},onBack:home });
  }
  function details(id, afterRevision = 0) {
    void run(() => controller.readDeletion('read',{id,afterRevision}), result => {
      const text = result.events.map(event => { const payload=event.payload_minimized?event.retained_payload:JSON.parse(event.payload_text);
        const eventName=({request:label('已提出申请','Request submitted'),cancel:label('已取消申请','Request canceled'),approve:label('已审核，尚未执行','Approved; not executed'),reject:label('申请未通过','Request declined'),'needs-information':label('需要补充说明','More information needed'),execute:label('已有删除处理记录','Deletion handling recorded')})[event.kind]??label('处理记录','Handling record');
        return `${eventName}${event.payload_minimized ? ' · '+label('原文已按保留期清理','Original text cleared under retention policy') : payload.explanation ? ' · '+plain(payload.explanation) : ''}`; }).join('\n');
      void records?.observe(result).catch(()=>{});
      const current=++view;
      select({title:`${stateName(result.state)}\n${text}\n${executionText(result)}`,
        options:[{number:'1',title:label('查看申请来源','Inspect request source'),description:''},
          ...(['requested','review-needed','approved'].includes(result.state)?[{number:'2',title:label('取消申请','Cancel request'),description:''}]:[]),
          ...(result.nextAfterRevision !== null ? [{number:'3',title:label('后续记录','More events'),description:''}]:[]),
          {number:'4',title:label('回到原工作','Return to original work'),description:''}],
        routes:{1:()=>{stop();info(label('原申请与准确记录','Original request and exact record'),JSON.stringify(result,null,2),()=>details(id));},2:()=>preview({action:'cancel',requestId:id,expectedRevision:result.revision}),3:()=>details(id,result.nextAfterRevision),4:returnWork},onBack:home});
      const poll=async()=>{
        if(current!==view||!isCurrent())return;
        try{const next=await controller.readDeletion('read',{id});if(current!==view||!isCurrent())return;if(next.revision!==result.revision)details(id);else timer=setTimeout(poll,15000);}catch{if(current===view&&isCurrent()){stop();info(label('当前申请暂不可读','Current request unavailable'),label('原申请已保留，可以返回或稍后再读。','The original request is retained. Return or read it again later.'),home);}}
      };
      if(!afterRevision&&['requested','review-needed','approved','partial'].includes(result.state))timer=setTimeout(poll,15000);
    });
  }
  function list(after) {
    void run(() => controller.readDeletion('query',after?{after,limit:7}:{limit:7}), result => {
      const routes={},options=result.items.map((item,i)=>{void records?.observe(item).catch(()=>{});routes[i+1]=()=>details(item.id);return{number:String(i+1),title:stateName(item.state),description:label('打开查看当前处理与说明','Open current handling and explanation')};});
      if(result.nextAfter){options.push({number:'9',title:label('下一页','Next page'),description:''});routes[9]=()=>list(result.nextAfter);}
      select({title:label('我的删除申请','My deletion requests'),options,routes,onBack:home});
    });
  }
  function home() {
    stop();generation++;
    if(!isCurrent())return;
    select({title:label('数据删除申请','Data deletion requests'),options:[...(canSubmit?[{number:'1',title:label('提交申请','Submit request'),description:label('申请后可查询审核结果','View review results after submission')},
      {number:'2',title:label('查看申请记录','View my requests'),description:''}]:[]),
      ...(controller.prepareDeletionStatus?[{number:'3',title:label('申请进度','Request progress'),description:label('查看本机已有申请','View requests already saved on this device')}]:[]),
      {number:'4',title:label('回到原工作','Return to original work'),description:''}],
      routes:{1:create,2:()=>list(),3:status,4:returnWork},onBack:back});
  }
  function status(){
    if(records)return void run(()=>records.list(),page=>statusRecords(page.records??[]));
    manualStatus();
  }
  function statusRecords(items,offset=0){stop();const current=++view,activate=fn=>()=>{if(current!==view||!isCurrent())return;view++;fn();};
    const routes={},options=items.slice(offset,offset+8).map((r,i)=>{routes[i+1]=activate(()=>statusRead(r.requestId));return{number:String(i+1),title:new Date(r.recordedAt*1000).toLocaleString(zh?'zh-CN':'en-US'),description:r.observedState?label('上次读取：','Last read: ')+stateName(r.observedState):label('提交结果尚未确认','Submission outcome unconfirmed')};});
    if(offset+8<items.length){options.push({number:'9',title:label('继续查看','More records'),description:''});routes[9]=activate(()=>statusRecords(items,offset+8));}
    else if(prompt){options.push({number:'9',title:label('查看其他已有申请','View another existing request'),description:label('使用在别处保存的申请引用','Use a request reference saved elsewhere')});routes[9]=activate(manualStatus);}
    select({title:label('选择已有申请','Choose an existing request')+(!items.length?'\n'+label('本机尚未保存申请记录。','No request records are saved on this device.'):'')+'\n'+label('选择后自动读取当前进度。','Select a request to read its current progress.'),options,routes,onBack:activate(offset?()=>statusRecords(items,offset-8):home)});
  }
  function manualStatus(){
    if(!prompt)return info(label('没有原申请记录','No original request record'),label('需要原申请引用才能查询。','An original request reference is required to query.'),home);
    prompt({title:label('已有申请引用','Existing request reference'),placeholder:'UUID',onCancel:home,onConfirm:requestId=>{
      if(!isCurrent())return;
      statusRead(requestId.trim());
    }});
  }
  // Choosing one's original request expresses a read-only purpose. Keep the
  // original client confirmation, holder key, endpoint and freshness checks;
  // no deletion request or Consent is submitted by this query.
  function statusRead(requestId){void run(async()=>{
      const value=await controller.prepareDeletionStatus({requestId});
      return controller.executeDeletionStatus(value,value.confirmation);
    },result=>{void records?.observe(result).catch(()=>{});info(stateName(result.state),executionText(result),home);});
  }
  return {open:home,close(){stop();generation++;controller.cancel();}};
}
