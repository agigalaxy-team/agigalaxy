import { nextCaseReviewStates } from '../../../packages/galaxy-contracts/src/case-review.mjs';
import {showExactChoice} from './exact-choice.mjs';

export function createCaseReviewMenu({controller,caseId,sourceVersion,select,prompt,info,language,isCurrent,onBack}){
  const zh=language!=='en-US',label=(a,b)=>zh?a:b,plain=value=>String(value??'').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,1200);
  let generation=0,current,draft;
  const guard=work=>{const version=generation;return (...args)=>{if(isCurrent()&&version===generation)return work(...args);};};
  const leave=()=>{generation++;controller.cancel();onBack();};
  function message(text,back=leave){if(isCurrent())info('Galaxy',text,guard(back));}
  async function run(work,done){
    const version=++generation;message(label('正在读取或准备；返回可取消。','Reading or preparing; return to cancel.'));
    try{const result=await work();if(isCurrent()&&version===generation)done(result);}
    catch(error){if(isCurrent()&&version===generation){controller.cancel();message(plain(error.message)+'\n'+label('请重新查询履历核对版本与远端结果。','Query history again to check the version and remote outcome.'));}}
  }
  function menu(title,entries,back=leave,offset=0){
    if(!isCurrent())return;generation++;
    const routes={},options=entries.slice(offset,offset+8).map(([title,work,description=''],index)=>{
      routes[index+1]=guard(work);return {number:String(index+1),title,description};
    });
    if(offset+8<entries.length){options.push({number:'9',title:label('下一页','Next page')});routes[9]=guard(()=>menu(title,entries,back,offset+8));}
    select({title,options,routes,onBack:guard(offset?()=>menu(title,entries,back,Math.max(0,offset-8)):back)});
  }
  function form(name,title,next){
    generation++;prompt({title,placeholder:draft[name]??'',onCancel:guard(edit),onConfirm:guard(value=>{
      const text=String(value).trim();if(!text||text.length>1200){message(label('请填写1至1200字。','Enter1 to1200 characters.'),edit);return;}
      draft[name]=text;next();
    })});
  }
  function edit(){
    menu(label('Case所有者说明；不是独立裁决','Case owner statement; not an independent decision')+'\n'+plain(caseId)+'\n'+
      label('私有修订可能使整条Case不再公开；请核对接收者。','A private revision can hide the entire Case from public history; review recipients.'),[
      [label('理由','Reason'),()=>form('reason',label('更改或复核理由','Reason for correction or review'),edit),plain(draft.reason)],
      [label('说明','Statement'),()=>form('summary',label('补充说明；原记录将保留','Statement; original record will remain'),edit),plain(draft.summary)],
      [label('可见性','Visibility'),()=>menu(label('选择可见性','Choose visibility'),[
        [label('私有','Private'),()=>{draft.visibility='Private';edit();}],
        [label('公开','Public'),()=>{draft.visibility='Public';draft.viewers=[];edit();}]],edit),draft.visibility],
      [label('私有接收者','Private recipients'),()=>{
        generation++;prompt({title:label('Galaxy ID，用逗号分隔；留空仅本人','Galaxy IDs, comma-separated; blank means only you'),placeholder:draft.viewers.join(', '),onCancel:guard(edit),onConfirm:guard(value=>{
          const viewers=[...new Set(String(value).split(/[,，\n]/).map(s=>s.trim()).filter(Boolean))];
          if(viewers.length>16||viewers.some(id=>!/^GUID[0-9A-Z]{28}$/.test(id))){message(label('请输入最多16个有效Galaxy ID。','Enter up to16 valid Galaxy IDs.'),edit);return;}
          draft.viewers=viewers;draft.visibility='Private';edit();
        })});
      },draft.viewers.join(', ')],
      [label('预览并确认','Preview and confirm'),()=>{
        if(!draft.reason||!draft.summary){message(label('请先填写理由和说明。','Enter a reason and statement first.'),edit);return;}
        void run(()=>controller.prepareCaseReview(structuredClone(draft)),confirm);
      }]],home);
  }
  function begin(targetEventId,review){draft={caseId,expectedVersion:sourceVersion,targetEventId,reason:'',summary:'',visibility:'Private',viewers:[],...(review?{review}:{})};edit();}
  function chooseTarget(review){menu(label('选择要纠正或复核的来源事件','Choose the source event to correct or review'),current.events.map(event=>[
    `${event.version} · ${plain(event.kind)} · ${plain(event.id)}`,()=>begin(event.id,review),plain(event.title??event.summary??event.approach)]),home);}
  function confirm(preview){
    generation++;
    const previewVersion=generation;
    const cancel=()=>{controller.cancel();edit();};
    showExactChoice({preview,title:label('保存本次工作说明','Save this work statement'),note:label('这是所有者的说明，不代表独立裁决。','This is the owner’s statement, not an independent decision.'),select,info,language,isCurrent:()=>isCurrent()&&generation===previewVersion,
      onCancel:guard(cancel),onConfirm:guard(value=>{
        void run(()=>controller.executeCaseReview(preview,value),receipt=>message(`${label('已追加事件；原记录保留','Event appended; original record retained')}\n${receipt.eventId}\n${label('来源版本','Source version')}: ${receipt.version}`));
      })});
  }
  function home(){
    menu(label('纠正与争议：Case所有者记录','Correction and dispute: Case owner records'),[
      [label('记录文字纠正','Record a text correction'),()=>chooseTarget()],
      [label('提出纠正复核','Open a correction review'),()=>chooseTarget({type:'correction',state:'opened'})],
      [label('记录争议','Record a dispute'),()=>chooseTarget({type:'dispute',state:'opened'})],
      [label('已有处理记录与状态','Existing review records and status'),()=>menu(label('已有复核话题','Existing review threads'),(current.reviews??[]).map(review=>[
        `${plain(review.type)} · ${plain(review.state)}`,()=>menu(`${plain(review.threadId)}\n${(review.changes??[]).map(change=>plain(change.state)+': '+plain(change.summary)).join('\n')}`,
          nextCaseReviewStates(review.state).map(state=>[plain(state),()=>begin(review.targetEventId,{threadId:review.threadId,type:review.type,state})]),home)]),home)]
    ]);
  }
  function open(){void run(async()=>{
    const status=await controller.status();
    if(status.state!=='session-local'||!['case-teaser','consent'].every(scope=>status.scopes?.includes(scope)))throw new Error('Case owner review scopes required.');
    const record=await controller.getCase(caseId);
    if(record.version!==sourceVersion||record.state==='withdrawn')throw new Error('Case version changed; query history again.');
    return record;
  },record=>{current=record;home();});}
  return {open};
}
