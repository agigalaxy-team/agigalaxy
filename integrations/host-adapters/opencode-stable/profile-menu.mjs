import { selfDeclaredProfileSchema } from '../../../packages/galaxy-official/src/shared/profile-schema.mjs';
import { createProjectDescriptionMenu } from './project-description-menu.mjs';

export function createProfileMenu({controller,select,prompt,info,language,isCurrent,onBack}){
  const zh=language!=='en-US',label=(a,b)=>zh?a:b;
  // oxlint-disable-next-line no-control-regex -- Prevent terminal controls in displayed user text.
  const plain=value=>String(value??'').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,2200);
  let generation=0,page,status,draft;
  const back=()=>{generation++;controller.cancel();onBack();};
  function gate(work){const version=generation;return (...args)=>{if(isCurrent()&&version===generation)return work(...args);};}
  async function run(work,done){
    const version=++generation;
    info(label('我的资料','My Profile'),label('正在处理；返回可取消。','Working; go back to cancel.'),gate(back));
    try{const result=await work();if(isCurrent()&&version===generation)done(result);}
    catch(error){if(isCurrent()&&version===generation)info(label('操作未完成','Operation incomplete'),plain(error.message)+'\n'+label('请重新读取资料核对；不会自动重发。','Reload your Profile to check; no automatic resend.'),gate(home));}
  }
  function home(){
    if(!isCurrent())return;
    void run(async()=>{
      const current=await controller.status();
      if(current.state!=='session-local'||!current.scopes?.includes('history')||!current.subjectId)throw new Error('Profile session required.');
      return {status:current,page:await controller.queryHistory({subjectId:current.subjectId,limit:8})};
    },result=>{
      page=result.page;status=result.status;
      const self=selfDeclaredProfileSchema.parse(page.selfDeclared??{});
      const selfText=[self.displayName,self.about,...(self.claimedCapabilities??[]),...(self.projects??[]).map(project=>`${project.kind} · ${project.title} · ${project.functions.join(' / ')}`)].filter(Boolean).map(plain).join('\n');
      const facts=page.items.map(item=>`${plain(item.title)} · ${plain(item.state)}`).join('\n');
      const editable=controller.prepareProfile&&controller.executeProfile&&status.scopes.includes('consent')&&Number.isSafeInteger(page.selfDeclaredRevision);
      select({title:label('我的资料','My Profile')+'\n'+status.subjectId+'\n\n'+label('自述（未经认证）','Self-declared (not certified)')+'\n'+(selfText||label('尚未填写；不影响参与','Optional; not required to participate'))+
        '\n\n'+label('事实派生履历（本页）','Derived history (this page)')+'\n'+(facts||label('暂无履历；不生成默认认证','No history; no default certification'))+
        (page.refresh?'\n'+label('读取时重算 / 检查时间','Rebuilt on read / checked at')+': '+new Date(page.refresh.checkedAt*1000).toISOString():''),
        options:[...(editable?[{number:'1',title:label('编辑自述','Edit self description'),description:label('不能编辑派生履历或Honor；默认仅本人可见','Derived history and Honor cannot be edited; private by default')}]:[]),
          {number:'2',title:label('重新读取','Reload'),description:page.nextCursor?label('履历仅展示第一页；完整列表使用查询履历','First history page only; use Search history for more'):''}],
        routes:{1:gate(()=>{if(!editable)return;draft={expectedRevision:page.selfDeclaredRevision,selfDeclared:structuredClone(self),visibility:'Private',viewers:[]};edit();}),2:gate(home)},onBack:gate(back)});
    });
  }
  function field(name,title,array=false){
    generation++;
    prompt({title,placeholder:array?(draft.selfDeclared[name]??[]).join(', '):draft.selfDeclared[name]??'',onCancel:gate(edit),onConfirm:gate(value=>{
      const candidate={...draft.selfDeclared,[name]:array?String(value).split(/[,，\n]/).map(v=>v.trim()).filter(Boolean):String(value)};
      try{draft.selfDeclared=selfDeclaredProfileSchema.parse(candidate);edit();}
      catch{info(label('内容超出限制','Content exceeds limits'),label('名称100字、简介2000字；能力最多20项，每项100字。','Name:100, about:2000; up to20 capabilities of100 characters each.'),gate(edit));}
    })});
  }
  function edit(){
    if(!isCurrent())return;generation++;
    select({title:label('编辑自述；保存前会预览全部内容','Edit self description; full preview before saving')+'\n'+label('这会替换全部自述；派生履历保持独立','Replaces the self description; derived history stays separate'),options:[
      {number:'1',title:label('显示名称','Display name'),description:plain(draft.selfDeclared.displayName)},
      {number:'2',title:label('简介','About'),description:plain(draft.selfDeclared.about)},
      {number:'3',title:label('自报能力','Claimed capabilities'),description:plain((draft.selfDeclared.claimedCapabilities??[]).join(', '))},
      {number:'4',title:label('可见性','Visibility'),description:draft.visibility},
      {number:'5',title:label('私有接收者','Private recipients'),description:draft.viewers.join(', ')},
      {number:'6',title:label('预览发布','Preview publication'),description:''},
      {number:'7',title:label('清空自述草稿','Clear self description draft'),description:label('仍需预览确认后才生效','Requires preview and confirmation to take effect')},
      {number:'8',title:label('项目／模块介绍','Project / module descriptions'),description:String(draft.selfDeclared.projects?.length??0)}],routes:{
        1:gate(()=>field('displayName',label('显示名称','Display name'))),2:gate(()=>field('about',label('简介','About'))),
        3:gate(()=>field('claimedCapabilities',label('自报能力，用逗号分隔；未经认证','Claimed capabilities, comma-separated; not certified'),true)),
        4:gate(()=>{generation++;select({title:label('选择可见性','Choose visibility'),options:[{number:'1',title:label('私有','Private')},{number:'2',title:label('公开','Public')}],routes:{1:gate(()=>{draft.visibility='Private';edit();}),2:gate(()=>{draft.visibility='Public';draft.viewers=[];edit();})},onBack:gate(edit)});}),
        5:gate(()=>{generation++;prompt({title:label('接收者 Galaxy ID，用逗号分隔；留空仅本人','Recipient Galaxy IDs, comma-separated; blank means only you'),placeholder:draft.viewers.join(', '),onCancel:gate(edit),onConfirm:gate(value=>{
          const viewers=[...new Set(String(value).split(/[,，\n]/).map(v=>v.trim()).filter(Boolean))];
          if(viewers.length>16||viewers.some(id=>!/^GUID[0-9A-Z]{28}$/.test(id))){info('Galaxy',label('请输入有效 Galaxy ID，最多16个。','Enter up to16 valid Galaxy IDs.'),gate(edit));return;}
          draft.visibility='Private';draft.viewers=viewers;edit();
        })});}),
        6:gate(()=>void run(()=>controller.prepareProfile(structuredClone(draft)),confirm)),
        7:gate(()=>{draft.selfDeclared={};edit();}),
        8:gate(()=>{const current=++generation;createProjectDescriptionMenu({projects:draft.selfDeclared.projects??[],
          onChange:projects=>{draft.selfDeclared={...draft.selfDeclared,projects};},select,prompt,info,language,
          isCurrent:()=>isCurrent()&&current===generation,onBack:edit}).open();})},onBack:gate(home)});
  }
  function confirm(preview){
    generation++;
    const cancel=()=>{generation++;controller.cancel();edit();};
    prompt({title:`${label('确认自述发布；不是能力认证','Confirm self description; not capability certification')}\n${preview.endpoint}\n${preview.payloadJson}\n${preview.intentJson}\n${preview.confirmation}`,
      placeholder:preview.confirmation,onCancel:gate(cancel),onConfirm:gate(value=>{
        if(value!==preview.confirmation){info('Galaxy',label('请输入完整确认文本。','Enter the exact confirmation.'),gate(()=>confirm(preview)));return;}
        void run(()=>controller.executeProfile(preview,value),receipt=>info(label('自述已记录','Self description recorded'),`${label('版本','Revision')}: ${receipt.revision}\n${label('自述不会授予能力认证。','Self description does not confer certification.')}`,gate(home)));
      })});
  }
  return {open:home};
}
