import {createServer} from 'node:http';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const built=await build({entryPoints:[fileURLToPath(new URL('./personal-summary-idb-entry.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'browser'});
const page='<!doctype html><html lang="zh"><meta charset="utf-8"><title>银河个人摘要 IndexedDB 合成验收</title><body><h1>个人摘要本地持久化验证</h1><p>仅测试专属合成数据库，不连接任何业务账号。</p><button>运行并验证页面重载</button><pre>尚未执行</pre><script type="module" src="/test.mjs"></script></body></html>';
const server=createServer((req,res)=>{if(!['/','/test.mjs'].includes(req.url)){res.writeHead(404);res.end();return;}
 res.writeHead(200,{'Content-Type':req.url==='/'?'text/html; charset=utf-8':'text/javascript; charset=utf-8','Cache-Control':'no-store'});res.end(req.url==='/'?page:built.outputFiles[0].text);});
server.listen(5184,'127.0.0.1',()=>console.log('Synthetic IDB test ready: http://127.0.0.1:5184'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
