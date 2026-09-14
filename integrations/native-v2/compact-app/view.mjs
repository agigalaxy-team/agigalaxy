// Shared DOM view for MCP Apps and the DSH plugin. All source text is rendered
// with textContent. The host adapter supplies only the five bounded panel calls.
export function mountCompactPanel(root,{call,displayMode,selectPath}={}){
 let current=null,navigationId=null,busy=false,destroyed=false,generation=0;
 const doc=root.ownerDocument,el=(tag,content,cls)=>{const n=doc.createElement(tag);if(content!==undefined)n.textContent=content;if(cls)n.className=cls;return n;};
 root.className='galaxy-compact';
 const header=el('header'),brand=el('strong','银河'),small=el('span','用户模型工作 · 银河提供协作与资料');header.append(brand,small);
 const status=el('p','等待当前对象…','status');status.setAttribute('role','status');
 const entries=el('nav'),source=el('section'),helps=el('section'),actions=el('div',undefined,'actions');
 const notes=el('section'),label=el('label','本机草稿'),draft=el('textarea');draft.rows=3;draft.maxLength=4000;label.append(draft);
 const noteState=el('span','不会自动发布、分享或上传云端'),noteSave=button('保存本机草稿',async()=>{const r=await invoke('galaxy_panel_draft_save',{expectedRevision:current.draft.revision,draft:draft.value});if(r?.draft){current.draft=r.draft;noteState.textContent='已保存到当前设备';}});
 notes.append(label,noteSave,noteState);root.replaceChildren(header,status,entries,source,helps,actions,notes);
 function button(title,fn){const b=el('button',title);b.type='button';b.addEventListener('click',()=>{if(!busy&&!destroyed)Promise.resolve(fn()).catch(showError);});return b;}
 function showError(e){status.textContent='未完成：'+(e.code??e.message??'panel_unavailable')+'。可保留草稿并在原聊天继续。';}
 async function invoke(name,args={}){if(!current)throw new Error('panel_not_ready');const start=generation;busy=true;status.textContent='正在处理…';
  try{const response=await call(name,{viewId:current.viewId,...args});if(destroyed||start!==generation)return null;
   if(response?.isError){const x=response.structuredContent??{};throw new Error(x.error??'panel_operation_failed');}
   const result=response?.structuredContent??response;status.textContent='操作回执已收到';return result;
  }catch(e){if(!destroyed&&start===generation){showError(e);if(name==='galaxy_panel_refresh'||name==='galaxy_panel_return'){source.replaceChildren(el('p','当前来源未重新确认，旧内容已隐藏。'));}}
   return null;
  }finally{busy=false;}
 }
 function receive(data){if(destroyed)return;if(data?.isError){showError(new Error(data.structuredContent?.error??'panel_operation_failed'));source.replaceChildren();return;}
  const next=data?.structuredContent??data;if(next?.schemaVersion!==1||!next.viewId)return;
  const same=current?.viewId===next.viewId,oldText=draft.value;current=next;generation++;
  // A host rerender of this same view must not erase unsaved typing.
  draft.value=same?oldText:next.draft?.text??'';
  entries.replaceChildren(...next.activeEntries.map(x=>button(x.label,()=>open(x.id))));entries.setAttribute('aria-label','主动入口');
  source.replaceChildren(el('h2',next.source?.title??(next.object?'当前对象':'从当前工作获得帮助')));
  if(next.object)source.append(el('code',next.object.kind+(next.object.id?' · '+next.object.id:'')+(next.object.versionId?' · 版本 '+next.object.versionId:'')));
  if(next.sourceError)source.append(el('p','目前无法读取：'+next.sourceError));
  else if(next.source){if(next.source.summary)source.append(el('p',next.source.summary));source.append(el('p','当前状态：'+(next.source.state??'未提供')));
   if(next.source.classification==='self-declared')source.append(el('p','项目自述；不等于能力或权属已验证。'));
   if(next.source.readingIsReuse===false)source.append(el('p','阅读 Capsule 不计作成功复用。'));
   if(next.source.history)source.append(el('p',next.source.history));
   const details=el('details'),summary=el('summary','准确来源与版本');details.append(summary,el('pre',JSON.stringify(next.source.source,null,2)));source.append(details);}
  helps.replaceChildren(el('h2','可选择的帮助方向'),el('p','由当前模型结合问题判断；不必依次尝试，也不代表已有参与者承诺。'));
  for(const p of next.paths){const row=el('div',undefined,'help-path');row.append(button(p.label,()=>selectPath?.({path:p.id,object:current.object,helpSessionId:current.help?.sessionId??null})),el('span',p.selectedHelpCount?'有本机选择记录，行动前刷新来源':'尚未读取具体人选或资源'));helps.append(row);}
  if(next.help?.offers?.length){const refs=el('details');refs.append(el('summary','已有帮助选择的来源定位（非当前授权证明）'),el('pre',JSON.stringify(next.help.offers,null,2)));helps.append(refs);}
  actions.replaceChildren(button('刷新当前资料',async()=>{const r=await invoke('galaxy_panel_refresh');if(r)receive(r);}),button('打开完整网页',()=>open()));
  if(navigationId)actions.append(button('返回后刷新',async()=>{const r=await invoke('galaxy_panel_return',{navigationId});if(r)receive(r);}));
  if(displayMode)actions.append(button('切换显示空间',()=>displayMode()));
  status.textContent='本次读取：'+new Date(next.checkedAt*1000).toLocaleString()+'。关闭界面不会取消任务或退出房间。';
 }
 async function open(entry){const r=await invoke('galaxy_panel_open',entry?{entry}:{});if(!r)return;navigationId=r.navigationId??null;
  status.textContent=r.launched?'已请求打开浏览器；页面是否完成打开尚未确认。':'浏览器未确认打开，可复制下面的精确网址。';
  if(r.url){const link=el('a',r.url);link.href=r.url;link.target='_blank';link.rel='noopener noreferrer';status.append(doc.createTextNode(' '),link);}
  if(navigationId&&!actions.querySelector('[data-return]')){const b=button('返回后刷新',async()=>{const result=await invoke('galaxy_panel_return',{navigationId});if(result)receive(result);});b.dataset.return='true';actions.append(b);}
 }
 return{receive,draftElement:draft,close(){destroyed=true;generation++;root.replaceChildren();}};
}

export const compactCss=`:root{color-scheme:light dark;font-family:system-ui,sans-serif}*{box-sizing:border-box}body{margin:0}.galaxy-compact{padding:16px;max-width:880px;margin:auto;font-size:14px;line-height:1.5;overflow-wrap:anywhere;color:var(--color-text-primary,inherit);background:var(--color-background-primary,transparent)}header{display:flex;gap:14px;align-items:center;flex-wrap:wrap}header strong{font-size:24px}header span,.status{font-size:12px;opacity:.8}nav,.actions{display:flex;gap:8px;flex-wrap:wrap}section{border-top:1px solid #8885;margin-top:14px;padding-top:12px}button{font:inherit;padding:8px 12px;border:1px solid #8e81b8;border-radius:8px;background:transparent;color:inherit;cursor:pointer}button:focus-visible,textarea:focus-visible{outline:3px solid #8d74e8;outline-offset:2px}h2{font-size:17px;margin:0 0 8px}.help-path{display:flex;gap:10px;align-items:center;margin:8px 0}.help-path span{font-size:12px}textarea{display:block;width:100%;font:inherit;border:1px solid #9998;border-radius:8px;padding:8px;resize:vertical;margin:6px 0}pre{max-height:220px;overflow:auto;font-size:12px;white-space:pre-wrap}code{font-size:12px}section>span{display:block;font-size:12px;margin-top:8px}@media(max-width:420px){.galaxy-compact{padding:10px}.help-path{display:block}.help-path span{display:block;margin-top:4px}nav button{flex:1}header span{display:none}}`;
