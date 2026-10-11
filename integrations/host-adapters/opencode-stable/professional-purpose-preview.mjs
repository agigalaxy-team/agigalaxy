import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {professionalPurposeFixture} from './professional-purpose-fixture.mjs';
import {createBuilderMenu} from './builder-menu.mjs';
import {createDeletionMenu} from './deletion-menu.mjs';
import {createCapsuleMenu} from './capsule-menu.mjs';
import {createA2aMenu} from './a2a-menu.mjs';
import {readableDialogSelect} from './dialog-reading.mjs';

const arg=name=>process.argv.find(v=>v.startsWith('--'+name+'='))?.slice(name.length+3),port=Number(arg('port')??0),kinds=(arg('kinds')??'builder,deletion,capsule,a2a').split(',');
assert.ok(Number.isSafeInteger(port)&&(port===0||port>=1024&&port<=65535));assert.ok(kinds.length&&new Set(kinds).size===kinds.length&&kinds.every(k=>['builder','deletion','capsule','a2a'].includes(k)));
const hosts=new Map();let server;
for(const kind of kinds){const fixture=await professionalPurposeFixture(kind),h={fixture,page:null,revision:0,returns:0,previews:new Map(),bridgeCalls:[]};
 const update=page=>{h.page=page;h.revision++;},returnWork=()=>{h.returns++;fixture.controller.cancel();update({kind:'info',title:'合成原工作',message:[fixture.root?.title??'合成：本次本人资料处理',fixture.root?.summary??'本次只在隔离服务提交删除申请和读取进度，未物理删除数据。'].join('\n\n'),onBack:()=>h.menu.open()});};
 const ui={controller:fixture.controller,language:'zh-CN',isCurrent:()=>true,onBack:()=>h.menu.open(),onReturnWork:returnWork,readWorkContext:fixture.readWorkContext,
  select:p=>update({kind:'select',...readableDialogSelect(p)}),prompt:p=>update({kind:'prompt',...p}),info:(title,message,onBack)=>update({kind:'info',title,message,onBack})};
 const availableScopes=(await fixture.controller.status()).scopes;
 h.menu=kind==='builder'?createBuilderMenu({...ui,availableScopes}):kind==='deletion'?createDeletionMenu({...ui,records:fixture.records}):kind==='capsule'?createCapsuleMenu({...ui,availableScopes}):createA2aMenu({...ui,availableScopes});
 hosts.set(kind,h);h.menu.open();
}
const html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Galaxy · 专业操作隔离镜像</title><style>body{margin:0;background:#f4f2ec;color:#15231d;font:16px/1.7 Segoe UI,Microsoft YaHei,sans-serif}main{max-width:780px;padding:20px;margin:auto}header{color:#52665c;font-size:13px}h1{font-size:22px;white-space:pre-wrap}p,small{white-space:pre-wrap}button{display:block;text-align:left;border:1px solid #afc2b7;border-radius:12px;padding:12px 16px;background:white;font:inherit;color:inherit;width:100%;margin:8px 0;cursor:pointer}small{display:block;color:#53635b;font-size:14px}textarea{font:inherit;width:100%;box-sizing:border-box;padding:12px;min-height:100px}nav{display:flex;gap:14px;flex-wrap:wrap}a{color:#265c45}</style><main><header>新进程 · 已安装 OpenCode Dialog 合同镜像<br>独立合成工作、CI 和身份；本机签名、HTTP、存储实际运行。未调用模型、未物理删除。</header><nav>${kinds.map(k=>'<a href="/'+k+'">'+({builder:'节点参与',deletion:'删除申请',capsule:'方法使用',a2a:'所选服务'})[k]+'</a>').join('')}</nav><section id="view"></section></main><script>
const kind=location.pathname.slice(1)||${JSON.stringify(kinds[0])},root=document.getElementById('view');let revision=-1,busy=false;
async function action(name,value){if(busy)return;busy=true;try{const response=await fetch('/action?kind='+kind,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision,action:name,value})});if(!response.ok)throw Error('current_action_changed');await read();}finally{busy=false;}}
function button(text,name,value,description){const b=document.createElement('button');b.textContent=text;b.setAttribute('aria-label',text);if(description){const small=document.createElement('small');small.textContent=description;b.append(small);}b.onclick=()=>action(name,value);root.append(b);return b;}
async function read(){const response=await fetch('/view?kind='+kind),data=await response.json();if(data.revision===revision)return;revision=data.revision;root.replaceChildren();const h=document.createElement('h1');h.textContent=data.title;root.append(h);
if(data.kind==='prompt'){const t=document.createElement('textarea');t.setAttribute('aria-label','当前内容');t.value=data.value??'';t.placeholder=data.placeholder??'';root.append(t);button('继续','input').onclick=()=>action('input',t.value);}
else if(data.kind==='info'){const p=document.createElement('p');p.textContent=data.message;root.append(p);button('继续','back');}
else for(const option of data.options??[]){if(option.reading){const p=document.createElement('p');p.textContent=option.description;root.append(p);button(option.title,'select',option.number);}else if(!option.disabled)button(option.title,'select',option.number,option.description);}button('返回','back');}
read();setInterval(()=>{if(!busy)read();},350);</script>`;
async function input(req){let raw='';for await(const part of req){raw+=part;if(raw.length>120000)throw Error('fixture_input_limit');}return JSON.parse(raw);}
async function observation(kind,h){const x=h.fixture,r={kind,syntheticOnly:true,actualSignedHttp:true,protocolVersion:1,modelCalls:0,returns:h.returns,state:x.state,bridgeCalls:h.bridgeCalls,
 root:x.root&&{caseId:x.root.id,title:x.root.title},result:x.result&&{resultId:x.result.id,outcome:x.result.outcome}};
 if(kind==='builder'){const current=await x.f.builders.get(x.f.actor,{builderId:x.builderId});r.current={builderId:x.builderId,name:current.declaration.name,nodeWorkEvidence:current.evidence.nodeWorkEvidence};}
 if(kind==='deletion'){r.localRecords=await x.records.list();r.requests=(await x.f.db.query('SELECT id,state,revision,payload_text,payload_hash FROM deletion_requests ORDER BY created_at')).rows.map(row=>({...row,payload:JSON.parse(row.payload_text),payload_text:undefined}));r.executions=(await x.f.db.query('SELECT count(*)::int n FROM deletion_executions')).rows[0].n;}
 if(kind==='capsule'){r.current=await x.f.capsules.get(x.f.actor,{capsuleId:x.published.capsuleId});r.uses=await x.f.capsules.uses(x.f.actor,{capsuleId:x.published.capsuleId,limit:20});r.application={caseId:x.application.root.id,resultId:x.application.result.id,proofId:x.application.proof.proofId};}
 if(kind==='a2a'){r.peerSends=x.peer.requests.filter(req=>req.body.method==='SendMessage').length;r.results=(await x.f.db.query("SELECT id,payload_text FROM case_events WHERE case_id=$1 AND kind='result' ORDER BY version",[x.root.id])).rows.map(row=>JSON.parse(row.payload_text));}
 return r;
}
// Only the installed-host test bridge uses this RPC. It retains the exact
// original controller object for prepare/execute identity checks. No keys or
// credentials leave the fixture, and no user choice is made by the bridge.
async function hostCall(h,{method,args=[]}){assert.ok(Object.hasOwn(h.fixture.controller,method)&&typeof h.fixture.controller[method]==='function');h.bridgeCalls.push(method);
 if(method.startsWith('execute')){const supplied=args[0],saved=h.previews.get(supplied?.fixturePreviewKey);if(!saved||saved.execute!==method)throw Error('original_fixture_preview_required');
  return h.fixture.controller[method](saved.preview,args[1]);}
 const value=await h.fixture.controller[method](...args);
 if(method.startsWith('prepare')&&value&&typeof value.confirmation==='string'){const token=randomUUID();h.previews.set(token,{preview:value,execute:method.replace(/^prepare/,'execute')});return{...value,fixturePreviewKey:token};}
 return value;
}
server=createServer(async(req,res)=>{try{res.setHeader('Cache-Control','no-store');const u=new URL(req.url,'http://127.0.0.1'),kind=u.searchParams.get('kind')??kinds[0],h=hosts.get(kind);assert.ok(h);
 if(u.pathname==='/view'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({...h.page,revision:h.revision}));}
 if(u.pathname==='/observation'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(await observation(kind,h)));}
 if(u.pathname==='/host/config'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({kind,methods:Object.keys(h.fixture.controller).filter(key=>!['prepare','execute'].includes(key)),context:await h.fixture.readWorkContext?.()}));}
 if(u.pathname==='/host/call'&&req.method==='POST'){const data=await input(req);res.setHeader('Content-Type','application/json');try{return res.end(JSON.stringify({value:await hostCall(h,data)}));}catch(error){return res.end(JSON.stringify({error:error.code??error.message}));}}
 if(u.pathname==='/action'&&req.method==='POST'){const data=await input(req);if(data.revision!==h.revision){res.statusCode=409;return res.end('{}');}const page=h.page;
  if(data.action==='select'){const option=page.options?.find(o=>o.number===String(data.value));if(option&&!option.disabled){if(option.reading){const original=page;h.page={kind:'info',title:page.title,message:option.description,onBack:()=>{h.page=original;h.revision++;}};h.revision++;}else page.routes?.[data.value]?.();}}
  else if(data.action==='input')page.onConfirm?.(String(data.value));else if(data.action==='back')(page.onBack??page.onCancel)?.();return res.end('{}');}
 res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);
 }catch(error){res.statusCode=500;res.end(JSON.stringify({error:'isolated_professional_fixture_incomplete'}));}});
await new Promise(ok=>server.listen(port,'127.0.0.1',ok));console.log(JSON.stringify({base:'http://127.0.0.1:'+server.address().port+'/',kinds,syntheticOnly:true,actualSignedHttp:true,actualTuiPluginApi:false,modelCalls:0}));
await new Promise(ok=>{process.once('SIGINT',ok);process.once('SIGTERM',ok);});for(const h of hosts.values()){h.menu.close?.();h.fixture.controller.cancel();}server.closeAllConnections();await new Promise(ok=>server.close(ok));for(const h of hosts.values())await h.fixture.close();
