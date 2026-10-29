import {createServer} from 'node:http';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const built=await build({entryPoints:[fileURLToPath(new URL('./device-key-idb-entry.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'browser'});
const page='<!doctype html><html lang="zh"><meta charset="utf-8"><title>银河设备钥 IndexedDB 合成验收</title><body><h1>设备钥本地持久化验证</h1><p>仅使用随机专属合成数据库；不创建真实银河身份，不连接业务服务。</p><button>运行并验证页面重载</button><pre>尚未执行</pre><script type="module" src="/test.mjs"></script></body></html>';
const server=createServer((request,response)=>{if(!['/','/test.mjs'].includes(request.url)){response.writeHead(404);response.end();return;}
 response.writeHead(200,{'Content-Type':request.url==='/'?'text/html; charset=utf-8':'text/javascript; charset=utf-8','Cache-Control':'no-store'});response.end(request.url==='/'?page:built.outputFiles[0].text);});
server.listen(5186,'127.0.0.1',()=>console.log('Synthetic CryptoKey IDB test ready: http://127.0.0.1:5186'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
