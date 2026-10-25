import {authoredRows,nativeAudienceLabel} from '../../../packages/galaxy-edge-mcp/src/native-v2/interaction/presentation.mjs';

const plain=value=>String(value??'').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ');
const parsed=value=>{try{return typeof value==='string'?JSON.parse(value):value;}catch{return null;}};
const scopeNames={binding:'设备连接',consent:'所选内容授权',history:'可见履历',assistance:'求助与参与',context:'所选材料',notifications:'消息通知',capsules:'知识胶囊',builders:'开放节点信息','case-teaser':'当前工作记录',proof:'来源证据',evidence:'提交的材料',audit:'本人操作记录','audit-review':'本人授权记录','data-export':'本人资料导出','data-delete':'本人资料删除'};

export function exactChoiceText(preview,{language='zh-CN',note='',readableContent=undefined,showAuthorizationExpiry=true}={}){
 const zh=language!=='en-US',payload=parsed(preview.payloadJson)??parsed(preview.previewJson)??parsed(preview.requestJson)??{},intent=parsed(preview.intentJson)??{};
 const rows=authoredRows([readableContent??payload,...(preview.participation?[preview.participation]:[])],{limit:80,maxText:48000}),lines=rows.filter(row=>!row.download).map(row=>plain(row.label)+'：'+plain(row.text));
 const endpoint=preview.endpoint??payload.endpoint;if(endpoint)lines.push((zh?'服务：':'Service: ')+plain(endpoint));
 const recipients=intent.viewers??preview.viewers??payload.viewers??payload.recipientIds??[];
 const visibility=intent.visibility??payload.visibility??preview.visibility;if(visibility)lines.push((zh?'可见范围：':'Visibility: ')+nativeAudienceLabel(visibility,recipients));
 if(recipients.length)lines.push((zh?'所选接收身份：':'Selected recipient identities: ')+recipients.map(plain).join('、'));
 const target=payload.target??payload;
 const scopes=target.scopes??payload.scopes;if(scopes?.length)lines.push((zh?'所选权限：':'Selected permissions: ')+scopes.map(value=>zh?scopeNames[value]??plain(value):plain(value)).join('、'));
 for(const [key,label]of [['readerId',zh?'读取者身份':'Reader identity'],['subjectIds',zh?'允许查询的身份':'Permitted identities']]){
  const value=payload[key];if(value)lines.push(label+'：'+(Array.isArray(value)?value.map(plain).join('、'):plain(value)));
 }
 const expires=intent.expiresAt??target.expiresAt??payload.expiresAt;if(expires&&(showAuthorizationExpiry||intent.expiresAt===undefined)){const date=new Date(typeof expires==='number'&&expires<1e12?expires*1000:expires);if(Number.isFinite(date.getTime()))lines.push((zh?'有效至：':'Valid until: ')+date.toLocaleString(zh?'zh-CN':'en-US'));}
 if(payload.action==='link'||payload.action==='unlink')lines.push(zh?'账户关联本身不授予业务资料读取权。':'Account association does not grant access to business data.');
 if(payload.action==='revoke-binding'){
  lines.push((zh?'所选设备连接：':'Selected device connection: ')+plain(target.installationId??preview.installationId??''));
  lines.push((zh?'绑定：':'Binding: ')+plain(target.bindingId??preview.bindingId??''));
  lines.push(zh?'撤销后，关联会话及依赖授权失效。':'Revocation ends the associated sessions and dependent grants.');
  if(payload.currentSession)lines.push(zh?'这就是当前连接；撤销后本机会话会断开。':'This is the current connection; revocation ends this session.');
 }
 if(note)lines.push(plain(note));
 if(!lines.length)lines.push(zh?'请先查看完整内容与范围，再选择本次操作。':'Read the full content and scope before choosing this operation.');
 return lines.join('\n\n');
}

// Only an actual native Dialog selection supplies the original confirmation.
// The same object, lifetime, owner and hashes remain enforced by its client.
export function showExactChoice({preview,title,select,info,isCurrent,onConfirm,onCancel,language='zh-CN',allowLabel='',note='',readableContent=undefined,actions=[],reviewInBody=false,readBeforeChoice=false,showAuthorizationExpiry=true}){
 const zh=language!=='en-US';let settled=false,view=0;
 const valid=()=>!settled&&isCurrent();
 const cancel=()=>{if(valid()){settled=true;view++;onCancel();}};
 const show=()=>{if(!valid())return;const token=++view;
  const activate=fn=>()=>{if(valid()&&view===token){view++;fn();}};
  const content=exactChoiceText(preview,{language,note,readableContent,showAuthorizationExpiry}),options=[
   {number:'1',title:allowLabel||(zh?'允许本次内容与范围':'Allow this content and scope'),description:reviewInBody?'':content,disabled:typeof preview.confirmation!=='string'||!preview.confirmation}
  ],routes={1:activate(()=>{if(typeof preview.confirmation!=='string'||!preview.confirmation)return;settled=true;onConfirm(preview.confirmation);})};
  for(const [title,action]of actions){const number=String(options.length+1);options.push({number,title});routes[number]=activate(()=>{settled=true;action();});}
  const source=String(options.length+1);options.push({number:source,title:zh?'查看来源与完整内容':'Inspect source and full content',description:zh?'需要核对具体字段或版本时查看。':'Inspect exact fields or versions when needed.'});
  routes[source]=activate(()=>{const body=[preview.previewJson,preview.payloadJson,preview.intentJson,preview.requestJson].filter(value=>typeof value==='string');const detail=++view;info(zh?'来源与完整内容':'Source and full content',body.join('\n\n'),()=>{if(valid()&&view===detail)show();});});
  const last=String(options.length+1);options.push({number:last,title:zh?'取消':'Cancel'});routes[last]=activate(cancel);
  select({title:plain(title)+(reviewInBody?'\n'+content:''),options,routes,onBack:activate(cancel)});
 };
 // The installed Select crops option descriptions. Professional previews use
 // the existing Alert for a full read before the one actual choice.
 // Closing that reading view has no signing, Consent or execution effect.
 if(readBeforeChoice&&valid()){const token=++view;info(plain(title),exactChoiceText(preview,{language,note,readableContent,showAuthorizationExpiry}),()=>{if(valid()&&view===token)show();});}
 else show();
 return{close(){settled=true;view++;}};
}
