import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {describeNativeChoice} from './presentation.mjs';
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
// A temporary local user surface for MCP clients without elicitation. It never
// receives keys, arbitrary commands or destination paths from the browser.
export function createNativeReview({now=()=>Date.now()}={}){
 let server,origin,starting,closed=false;const entries=new Map();
 const prune=()=>{for(const[k,v]of entries)if(v.expiresAt<=now())entries.delete(k);};
 // Keep cross-origin referrers suppressed while allowing the browser's actual
 // same-origin form POST to carry its Origin. Null/foreign Origins stay denied.
 const response=(res,status,body)=>{res.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'same-origin',
  'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",'x-content-type-options':'nosniff'});res.end(body);};
 async function start(){if(closed)throw new Error('native_review_closed');if(server)return;if(starting)return starting;
  starting=new Promise((resolve,reject)=>{server=createServer(async(req,res)=>{
   prune();if(req.headers.host!==new URL(origin).host)return response(res,403,'本机审阅地址不匹配。');
   const requestUrl=new URL(req.url??'/',origin),path=requestUrl.pathname,entry=entries.get(path);if(!entry)return response(res,404,'本次审阅不存在或已过期。请返回原宿主查询当前状态。');
   if(req.headers['sec-fetch-site']==='cross-site'&&req.method!=='GET')return response(res,403,'拒绝跨站提交。');
   if(req.method==='POST'){
    if(req.headers.origin!==origin||req.headers['content-type']?.split(';')[0]!=='application/x-www-form-urlencoded')return response(res,403,'请在本机审阅页面操作。');
    let body='';for await(const chunk of req){body+=chunk;if(body.length>200)return response(res,413,'提交过长。');}
    const data=new URLSearchParams(body),action=data.get('action');
    if(data.size!==1||!['allow','decline'].includes(action))return response(res,400,'选择无效。');
    if(entry.state==='pending')entry.state=action==='allow'?'accepted':'declined';
    return response(res,200,'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>银河本机选择</title><p>'+ (entry.state==='accepted'?'已允许本次显示的操作。回到原聊天继续。':entry.state==='consumed'?'本次允许已用于原操作，不能再次授权。':'已取消。本次操作没有获得授权。')+'</p>');
   }
   if(req.method!=='GET')return response(res,405,'Method unavailable');
   if(requestUrl.search==='?download=1'){res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','content-disposition':'attachment; filename="galaxy-operation.json"','x-content-type-options':'nosniff'});return res.end(entry.exact);}
   const choice=entry.view;
   const rows=choice.rows.map(row=>'<section>'+(row.download?'<a download="galaxy-content.json" href="data:application/json;charset=utf-8,'+escape(encodeURIComponent(row.download))+'">下载本次完整内容</a>':'<h2>'+escape(row.label)+'</h2><p class="content">'+escape(row.text)+'</p>')+'</section>').join('');
   const scope=choice.sections.map(row=>'<div><dt>'+escape(row.label)+'</dt><dd>'+escape(row.text)+'</dd></div>').join('');
   const refs=(choice.recipientRefs.length?'<section aria-label="接收方身份"><h2>接收方身份</h2><p>这些成员尚未提供可显示的名称。请按已有身份核对。</p>'+choice.recipientRefs.map(ref=>'<p class="ref">'+escape(ref)+'</p>').join('')+'</section>':'')+(choice.identityRefs.length?'<section aria-label="身份与设备"><h2>身份与设备</h2>'+choice.identityRefs.map(ref=>'<p class="ref">'+escape(ref.label)+'：'+escape(ref.value)+'</p>').join('')+'</section>':'');
   const choices=entry.state==='pending'?'<form method="post" action="'+escape(path)+'"><button class="primary" type="submit" name="action" value="allow">允许本次操作</button><button type="submit" name="action" value="decline">取消</button></form>':'<p>'+({accepted:'已允许。可以回到原聊天继续。',declined:'已取消，本次操作没有获得授权。','declined-delivered':'已取消，本次操作没有获得授权。',consumed:'这次授权已用于原操作。'}[entry.state]??'请选择后回到原聊天。')+'</p>';
   return response(res,200,'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>银河 · '+escape(choice.title)+'</title><style>body{font:16px/1.65 system-ui;max-width:680px;margin:28px auto;padding:0 20px 48px;background:#fff;color:#25252c}header{color:#686471;font-size:14px}h1{font-size:26px;margin:20px 0}h2{font-size:14px;color:#686471;margin:0 0 5px}section{margin:22px 0}.content{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}dl{background:white;border:1px solid #e5e7eb;border-radius:12px;padding:12px 18px}dl div{padding:7px 0}dt{color:#686471;font-size:14px}dd{margin:0;overflow-wrap:anywhere}button{font:inherit;padding:11px 22px;margin:8px 10px 8px 0;border:1px solid #e5e7eb;border-radius:9px;background:white;cursor:pointer}.primary{background:#9d496a;color:white;border-color:#9d496a}button:focus-visible,a:focus-visible,button:focus-visible{outline:3px solid #d8a9be;outline-offset:3px}.muted{font-size:14px;color:#686471}.ref{font-size:14px;color:#686471}.ref{overflow-wrap:anywhere}a{color:#9d496a}</style><header>银河 · 当前宿主的本机选择</header><h1>'+escape(choice.title)+'</h1>'+rows+(scope?'<dl>'+scope+'</dl>':'')+'<p class="muted">'+escape(choice.note)+'有效至 '+escape(new Date(entry.expiresAt).toLocaleTimeString('zh-CN'))+'。</p>'+choices+refs+'<section aria-label="来源与诊断"><h2>来源与诊断</h2><p>保留本次输入、准确身份与引用，供需要核对或诊断时查看。</p><a href="'+escape(path)+'?download=1" download="galaxy-operation.json">下载本次完整操作</a></section></html>');
  });server.once('error',reject);server.listen(0,'127.0.0.1',()=>{origin='http://127.0.0.1:'+server.address().port;server.unref();resolve();});});
  try{await starting;}finally{starting=null;}
 }
 async function request({key,name,input,identity}){
  await start();prune();let found=[...entries].find(([,e])=>e.key===key&&e.state!=='consumed'&&e.state!=='declined-delivered');
  if(!found){const until=input?.expiresAt??input?.preview?.expiresAt,deadline=typeof until==='number'?(until<1e12?until*1000:until):Date.parse(until);
   const path='/review/'+randomBytes(24).toString('hex'),entry={key,state:'pending',expiresAt:Math.min(now()+300000,Number.isFinite(deadline)?deadline:Infinity),view:describeNativeChoice(name,input),exact:JSON.stringify({operation:name,identity:identity||'尚未初始化',input},null,2)};entries.set(path,entry);found=[path,entry];}
  const[path,entry]=found;return{state:entry.state,url:origin+path,expiresAt:entry.expiresAt,sideEffect:false,reviewSurface:'temporary-local-browser'};
 }
 function close(){closed=true;entries.clear();server?.closeAllConnections();server?.close();server=null;}
 function consume(key){prune();const entry=[...entries.values()].find(value=>value.key===key&&value.state==='accepted');if(!entry)return false;entry.state='consumed';return true;}
 // Report a cancellation once to the original caller, retaining its exact
 // local page. A later explicit request may make a new choice, never reuse
 // this cancellation as permission or revive the canceled business action.
 function dismiss(key){const entry=[...entries.values()].find(value=>value.key===key&&value.state==='declined');if(entry)entry.state='declined-delivered';}
 return{request,consume,dismiss,close};
}
