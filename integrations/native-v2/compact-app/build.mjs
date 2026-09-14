import {build} from '../../../node_modules/esbuild/lib/main.js';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=new URL('./',import.meta.url);
export async function buildCompactApp(){
 const result=await build({entryPoints:[fileURLToPath(new URL('browser.mjs',root))],bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',minify:true,legalComments:'eof',metafile:true});
 const code=result.outputFiles[0].text.replace(/<\/script/gi,'<\\/script');
 const html='<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>银河</title></head><body><main id="galaxy"></main><script>'+code+'</script></body></html>';
 const sha256=createHash('sha256').update(html).digest('hex'),uri='ui://galaxy/compact/'+sha256.slice(0,24)+'.html';
 await mkdir(new URL('dist/',root),{recursive:true});await writeFile(new URL('dist/panel.html',root),html);
 const license=await readFile(new URL('node_modules/@modelcontextprotocol/ext-apps/LICENSE',root),'utf8');
 await writeFile(new URL('dist/EXT_APPS_LICENSE.txt',root),license);
 const manifest={schemaVersion:1,uri,sha256,bytes:Buffer.byteLength(html),sdk:'@modelcontextprotocol/ext-apps@2.0.0',modelCalls:0,hostAcceptance:'not-claimed',inputs:Object.keys(result.metafile.inputs)};
 await writeFile(new URL('dist/manifest.json',root),JSON.stringify(manifest,null,2)+'\n');return manifest;
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(JSON.stringify(await buildCompactApp()));
