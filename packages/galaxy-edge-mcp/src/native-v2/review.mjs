import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
// A temporary local user surface for MCP clients without elicitation. It never
// receives keys, arbitrary commands or destination paths from the browser.
export function createNativeReview({now=()=>Date.now()}={}){
 let server,origin,starting,closed=false;const entries=new Map();
 const prune=()=>{for(const[k,v]of entries)if(v.expiresAt<=now())entries.delete(k);};
 const response=(res,status,body)=>{res.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer',
  'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",'x-content-type-options':'nosniff'});res.end(body);};
 async function start(){if(closed)throw new Error('native_review_closed');if(server)return;if(starting)return starting;
  starting=new Promise((resolve,reject)=>{server=createServer(async(req,res)=>{
   prune();if(req.headers.host!==new URL(origin).host)return response(res,403,'本机审阅地址不匹配。');
   const path=req.url??'',entry=entries.get(path);if(!entry)return response(res,404,'本次审阅不存在或已过期。请返回原宿主查询当前状态。');
   if(req.headers['sec-fetch-site']==='cross-site'&&req.method!=='GET')return response(res,403,'拒绝跨站提交。');
   if(req.method==='POST'){
    if(req.headers.origin!==origin||req.headers['content-type']?.split(';')[0]!=='application/x-www-form-urlencoded')return response(res,403,'请在本机审阅页面操作。');
    let body='';for await(const chunk of req){body+=chunk;if(body.length>200)return response(res,413,'提交过长。');}
    const data=new URLSearchParams(body),action=data.get('action');
    if(data.size!==1||!['allow','decline'].includes(action))return response(res,400,'选择无效。');
    if(entry.state==='pending')entry.state=action==='allow'?'accepted':'declined';
    return response(res,200,'<!doctype html><meta charset="utf-8"><title>银河本机选择</title><p>'+ (entry.state==='accepted'?'已允许显示的操作。返回原宿主重试同一操作以继续。':'已拒绝。本次操作没有获得授权。')+'</p><p>关闭页面不会触发其他操作。</p>');
   }
   if(req.method!=='GET')return response(res,405,'Method unavailable');
   const choices=entry.state==='pending'?'<form method="post"><button type="submit" name="action" value="allow">允许本次显示的操作</button> <button type="submit" name="action" value="decline">拒绝</button></form>':'<p>已选择：'+escape(entry.state)+'。请返回原宿主。</p>';
   return response(res,200,'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>银河 · 本机操作审阅</title><style>body{font:16px/1.65 system-ui;max-width:850px;margin:32px auto;padding:0 20px;background:#fafafa;color:#171717}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eee;padding:16px}button{font:inherit;padding:10px 18px;margin:8px 0}h1{font-size:24px}</style><h1>银河 · 本机操作审阅</h1><p>这是当前宿主的临时本机批准页。官网房间是另一种页面。本页不接收恢复码或密钥。</p><p>以下内容来自请求，作为待审数据展示。</p><pre>'+escape(entry.preview)+'</pre><p>只允许显示的操作与范围。有效期 5 分钟；关闭页面不会批准。</p>'+choices+'</html>');
  });server.once('error',reject);server.listen(0,'127.0.0.1',()=>{origin='http://127.0.0.1:'+server.address().port;server.unref();resolve();});});
  try{await starting;}finally{starting=null;}
 }
 async function request({key,name,input,identity}){
  await start();prune();let found=[...entries].find(([,e])=>e.key===key);
  if(!found){const path='/review/'+randomBytes(24).toString('hex'),entry={key,state:'pending',expiresAt:now()+300000,preview:JSON.stringify({operation:name,identity:identity||'尚未初始化',input},null,2)};entries.set(path,entry);found=[path,entry];}
  const[path,entry]=found;return{state:entry.state,url:origin+path,expiresAt:entry.expiresAt,sideEffect:false,reviewSurface:'temporary-local-browser'};
 }
 function close(){closed=true;entries.clear();server?.closeAllConnections();server?.close();server=null;}
 return{request,close};
}
