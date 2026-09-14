export function createDeletionMenu({ controller, select, prompt, info, language, isCurrent, onBack, canSubmit = true }) {
  const zh = language !== 'en-US', label = (a,b) => zh ? a : b;
  const plain = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,1000);
  const names = { requested: ['已申请','Requested'], 'review-needed': ['待补充信息','Information needed'], approved: ['已审核，尚未执行','Approved; not executed'], rejected: ['未获通过','Declined'], cancelled: ['已取消','Cancelled'] };
  const stateName = state => names[state] ? label(...names[state]) : plain(state);
  names.partial=['部分数据待处理','Some data remains'];names['primary-erased']=['主库本人数据已删除','Owned primary data erased'];
  const executionText = result => result.execution
    ? `${label('本次删除记录数','Rows deleted this run')}: ${Object.values(result.execution.deletedCounts).reduce((a,b)=>a+Number(b),0)}\n${label('待处理记录数','Remaining rows')}: ${Object.values(result.execution.remainingCounts).reduce((a,b)=>a+Number(b),0)}\n${label('审计记录状态','Audit state')}: ${plain(result.execution.audit.state)}\n${label('备份删除和到期处理尚未确认；不能视为全部删除完成','Backup deletion and expiry are unverified; service-wide deletion is incomplete')}`
    : label('尚未物理删除数据','Data has not been physically deleted');
  let generation = 0;
  const back = () => { generation++; controller.cancel(); onBack(); };
  async function run(work, done) {
    const version = ++generation;
    info(label('数据删除申请','Data deletion request'),label('正在处理','Working'),back);
    try { const value = await work(); if (version === generation && isCurrent()) done(value); }
    catch(error) { if (version === generation && isCurrent()) info(label('操作未完成','Operation incomplete'),plain(error.message),home); }
  }
  function preview(input) {
    void run(() => controller.prepareDeletion(input), value => {
      const intent = JSON.parse(value.payloadJson);
      select({ title: `${label('确认删除申请操作','Confirm deletion request')}\n${value.endpoint}\n${intent.subjectId}\n${value.requestId}\n` +
        (intent.action === 'cancel' ? label('取消尚未执行的申请','Cancel a request that has not been executed')
          : label(`范围：全部本人云端数据。${intent.takeout === 'already-exported' ? '已自行取回。' : '不需要先导出。'}本次提交申请，不立即擦除数据。`,
            `Scope: all owned service data. ${intent.takeout === 'already-exported' ? 'Already exported.' : 'Export not needed.'} Submission does not immediately erase data.`)),
        options: [{ number:'1',title:label('签名并提交','Sign and submit'),description:'' },{number:'2',title:label('返回','Back'),description:''}],
        routes: { 1: () => void run(() => controller.executeDeletion(value,value.confirmation), result => details(result.id)),
          2: () => { controller.cancel(); home(); } }, onBack: () => { controller.cancel(); home(); } });
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
        return `${event.revision} · ${plain(event.kind)}${event.payload_minimized ? ' · '+label('原文已按保留期清理','Original text cleared under retention policy') : payload.explanation ? ' · '+plain(payload.explanation) : ''}`; }).join('\n');
      select({title:`${stateName(result.state)}\n${result.id}\n${text}\n${executionText(result)}`,
        options:[{number:'1',title:label('刷新','Refresh'),description:''},
          ...(['requested','review-needed','approved'].includes(result.state)?[{number:'2',title:label('取消申请','Cancel request'),description:''}]:[]),
          ...(result.nextAfterRevision !== null ? [{number:'3',title:label('后续记录','More events'),description:''}]:[])],
        routes:{1:()=>details(id),2:()=>preview({action:'cancel',requestId:id,expectedRevision:result.revision}),3:()=>details(id,result.nextAfterRevision)},onBack:home});
    });
  }
  function list(after) {
    void run(() => controller.readDeletion('query',after?{after,limit:7}:{limit:7}), result => {
      const routes={},options=result.items.map((item,i)=>{routes[i+1]=()=>details(item.id);return{number:String(i+1),title:stateName(item.state),description:item.id};});
      if(result.nextAfter){options.push({number:'9',title:label('下一页','Next page'),description:''});routes[9]=()=>list(result.nextAfter);}
      select({title:label('我的删除申请','My deletion requests'),options,routes,onBack:home});
    });
  }
  function home() {
    if(!isCurrent())return;
    select({title:label('数据删除申请','Data deletion requests'),options:[...(canSubmit?[{number:'1',title:label('提交申请','Submit request'),description:label('申请后可查询审核结果','View review results after submission')},
      {number:'2',title:label('查看申请记录','View my requests'),description:''}]:[]),
      ...(prompt&&controller.prepareDeletionStatus?[{number:'3',title:label('凭本机身份查询回执','Check receipt with local identity'),description:label('输入原申请ID；不需要云端登录','Enter the original request ID; no cloud login required')}]:[])],
      routes:{1:create,2:()=>list(),3:status},onBack:back});
  }
  function status(){
    prompt({title:label('删除申请 ID','Deletion request ID'),placeholder:'UUID',onCancel:home,onConfirm:requestId=>{
      if(!isCurrent())return;
      void run(()=>controller.prepareDeletionStatus({requestId:requestId.trim()}),value=>{
        select({title:`${label('签名查询删除回执','Sign deletion status query')}\n${plain(value.endpoint)}\n${plain(value.requestId)}\n${plain(JSON.parse(value.payloadJson).subjectId)}`,
          options:[{number:'1',title:label('签名并查询','Sign and query'),description:''}],routes:{1:()=>void run(()=>controller.executeDeletionStatus(value,value.confirmation),result=>
            info(stateName(result.state),`${plain(result.id)}\n${executionText(result)}`,home))},onBack:()=>{controller.cancel();home();}});
      });
    }});
  }
  return {open:home};
}
