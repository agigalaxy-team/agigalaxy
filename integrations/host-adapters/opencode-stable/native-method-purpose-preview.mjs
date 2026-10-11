import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {createCapsulePurposeFixture,connectCapsulePurposeFixture} from './capsule-purpose-fixture.mjs';
import {createNativeCapsuleMenu} from './capsule-native-menu.mjs';
import {readableDialogSelect} from './dialog-reading.mjs';
import {nativeChoiceUrl} from '../../native-v2/compact-app/browser-choice.mjs';

const port=Number(process.argv.find(arg=>arg.startsWith('--port='))?.slice(7)??0);assert.ok(Number.isSafeInteger(port)&&(port===0||port>=1024&&port<=65535));
const bridge=process.argv.find(arg=>arg.startsWith('--bridge='))?.slice(9);
const fixture=bridge?await connectCapsulePurposeFixture(bridge):await createCapsulePurposeFixture(),out=resolve('../../../07-logs/development/ui-reconstruction-20261009/native-method-current-batch');await mkdir(out,{recursive:true});
let page,revision=0,choiceUrl=null,returned=0,server;
const setPage=value=>{page=value;revision++;};
const allowed=new Set(['galaxy_native_status','galaxy_profile_names','galaxy_capsule_work_sources','galaxy_capsule_work_read','galaxy_capsule_work_prepare','galaxy_capsule_work_execute','galaxy_capsule_work_application','galaxy_capsule_work_status','galaxy_capsule_work_pending','galaxy_capsule_v2_query','galaxy_capsule_v2_read','galaxy_capsule_v2_versions']);
const call=(name,args)=>{if(!allowed.has(name))throw Error('synthetic_method_tool_unavailable');return fixture.call(name,args);};
async function openLink(url){choiceUrl=nativeChoiceUrl(url);if(!choiceUrl)throw Error('synthetic_local_choice_required');return{launched:false};}
const menu=createNativeCapsuleMenu({call,readWorkContext:fixture.readWorkContext,openLink,isCurrent:()=>true,language:'zh-CN',select:p=>setPage({kind:'select',...readableDialogSelect(p)}),prompt:p=>setPage({kind:'prompt',...p}),info:(title,message,onBack)=>setPage({kind:'info',title,message,onBack}),onBack:()=>menu.home(),onReturnWork:()=>{
 returned++;void fixture.observation().then(value=>setPage({kind:'info',title:'合成原工作',message:fixture.source.root.title+'\n\n'+fixture.source.root.summary+'\n\n'+value.current.title+' · 版本 '+value.current.version+'\n'+value.current.solutionStrategy+'\n\n'+value.uses.map(use=>use.note+'\n'+({partial:'部分完成',succeeded:'已完成'}[use.outcome]??use.outcome)).join('\n\n'),onBack:()=>menu.home()}));
}});menu.home();
const html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Galaxy · 合成方法工作</title><style>body{margin:0;background:#f4f2ec;color:#15231d;font:16px/1.7 Segoe UI,Microsoft YaHei,sans-serif}main{max-width:780px;margin:auto;padding:20px}header{font-size:13px;color:#52665c}h1{font-size:22px;white-space:pre-wrap}p,small{white-space:pre-wrap}button,a.choice{display:block;border:1px solid #afc2b7;border-radius:12px;padding:12px 16px;margin:8px 0;width:100%;box-sizing:border-box;text-align:left;font:inherit;color:inherit;background:white;text-decoration:none;cursor:pointer}small{display:block;font-size:14px;color:#53635b}textarea{font:inherit;width:100%;min-height:150px;box-sizing:border-box;padding:12px}</style><main><header>隔离 Native v2 / Dialog 合同镜像 · 真实签名 HTTP 与本机存储<br>合成工作；此页面不代表实际 OpenCode TUI 或模型</header><section id="view"></section></main><script>
const root=document.getElementById('view');let revision=-1,busy=false;async function action(action,value){if(busy)return;busy=true;try{await fetch('/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision,action,value})});await read();}finally{busy=false;}}
function button(text,actionName,value,description){const b=document.createElement('button');b.textContent=text;b.setAttribute('aria-label',text);if(description){const s=document.createElement('small');s.textContent=description;b.append(s);}b.onclick=()=>action(actionName,value);root.append(b);return b;}
async function read(){const d=await(await fetch('/view')).json();if(d.revision===revision)return;revision=d.revision;root.replaceChildren();const h=document.createElement('h1');h.textContent=d.title;root.append(h);
if(d.kind==='prompt'){const t=document.createElement('textarea');t.setAttribute('aria-label','当前内容');t.value=d.value??'';t.placeholder=d.placeholder??'';root.append(t);button('继续','input').onclick=()=>action('input',t.value);}
else if(d.kind==='info'){const p=document.createElement('p');p.textContent=d.message??'';root.append(p);if(d.title==='等待你的选择'&&d.choiceUrl){const a=document.createElement('a');a.href=d.choiceUrl;a.className='choice';a.target='_blank';a.textContent='打开本机选择页';root.append(a);}button('继续','back');}
else for(const o of d.options??[]){if(o.reading){const p=document.createElement('p');p.textContent=o.description;root.append(p);button(o.title,'select',o.number);}else if(!o.disabled)button(o.title,'select',o.number,o.description);}
button('返回','back');}read();setInterval(()=>{if(!busy)read();},350);</script>`;
async function input(req){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>50000)throw Error('synthetic_input_limit');}return JSON.parse(raw);}
server=createServer(async(req,res)=>{try{const path=new URL(req.url,'http://127.0.0.1').pathname;res.setHeader('Cache-Control','no-store');
 if(path==='/context'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(await fixture.readWorkContext()));}
 if(path==='/observation'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({...await fixture.observation(),returned,choiceUrl,...(fixture.bridgeTo?{bridgeTo:fixture.bridgeTo}:{} )}));}
 if(path==='/tools'&&req.method==='POST'){const value=await input(req),result=await call(value.name,value.args??{}),content=result.structuredContent??(result.content?.[0]?.text?JSON.parse(result.content[0].text):null);if(content?.state==='user-choice-needs-browser')choiceUrl=nativeChoiceUrl(content.url);res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(result));}
 if(path==='/view'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({...page,revision,choiceUrl}));}
 if(path==='/action'&&req.method==='POST'){const value=await input(req);if(value.revision!==revision){res.statusCode=409;return res.end('{}');}const current=page;
  if(value.action==='select'){const option=current.options?.find(o=>o.number===String(value.value));if(option&&!option.disabled){if(option.reading)setPage({kind:'info',title:current.title,message:option.description,onBack:()=>setPage(current)});else current.routes?.[value.value]?.();}}
  else if(value.action==='input')current.onConfirm?.(String(value.value));else if(value.action==='back')(current.onBack??current.onCancel)?.();return res.end('{}');}
 res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);
}catch(error){res.statusCode=500;res.end(JSON.stringify({error:'synthetic_method_fixture_incomplete'}));}});
await new Promise(ok=>server.listen(port,'127.0.0.1',ok));console.log(JSON.stringify({previewUrl:'http://127.0.0.1:'+server.address().port+'/methods',bridgeUrl:'http://127.0.0.1:'+server.address().port,actualNativeMcp:true,actualSignedHttp:true,syntheticWork:true,modelCalls:0,actualTuiPluginApi:false}));
await new Promise(ok=>{process.once('SIGINT',ok);process.once('SIGTERM',ok);});
await writeFile(resolve(out,'preview-'+server.address().port+'.json'),JSON.stringify({...await fixture.observation(),returned,recordedAt:new Date().toISOString()},null,2)+'\n');menu.close();server.closeAllConnections();await new Promise(ok=>server.close(ok));await fixture.close();
