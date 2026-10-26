import { readFile,writeFile,readdir } from 'node:fs/promises';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { resolve,relative } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { businessApiReference,specialApiReference } from '../packages/galaxy-official/api-reference.mjs';
import { migrations } from '../packages/galaxy-official/src/infrastructure/migrations.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const sha=value=>createHash('sha256').update(value).digest('hex');
async function sourceFiles(directory){const files=[];for(const entry of await readdir(directory,{withFileTypes:true})){
  if(entry.isDirectory())files.push(...await sourceFiles(resolve(directory,entry.name)));
  else if(entry.name.endsWith('.mjs'))files.push(resolve(directory,entry.name));
}return files.sort((a,b)=>a<b?-1:a>b?1:0);}
export async function buildApiReference({check=false}={}) {
  const sources={},errors=[];
  for(const path of await sourceFiles(resolve(root,'packages/galaxy-official/src'))){
    const name=relative(root,path).replaceAll('\\','/'),source=await readFile(path,'utf8');sources[name]=sha(source);
    const tree=ts.createSourceFile(name,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    const visit=node=>{
      if(ts.isNewExpression(node)&&node.expression.getText(tree)==='ServiceError'&&node.arguments?.length&&ts.isStringLiteral(node.arguments[0])){
        const status=node.arguments[1];errors.push({code:node.arguments[0].text,status:status===undefined?400:ts.isNumericLiteral(status)?Number(status.text):null,
          source:name,line:tree.getLineAndCharacterOfPosition(node.getStart(tree)).line+1});
      }
      ts.forEachChild(node,visit);
    };visit(tree);
  }
  const entries=[...businessApiReference,...specialApiReference];
  const catalog={version:1,kind:'development-source-reference-not-deployed-api',publicApiEndpoints:[],
    coverage:'authored-subset-not-complete-current-http-surface',migrationVersions:migrations.map(item=>item.version),
    serviceVersion:JSON.parse(await readFile(resolve(root,'packages/galaxy-official/package.json'),'utf8')).version,schema:migrations.at(-1).version,
    endpointPolicy:'Paths are relative to an explicitly configured isolated service; no production base URL, OAuth credential or runnable public server is supplied.',
    entries,sources};
  // Exact machine reference only; the maintained interface explanation is never generated over.
  const outputs={'docs/technical/reference/development-api-reference-v1.json':JSON.stringify(catalog,null,2)+'\n',
    'docs/technical/reference/api-error-catalog-v0.1.json':JSON.stringify({version:1,kind:'static-literal-declarations-not-exhaustive-runtime-reachability',entries:errors},null,2)+'\n'};
  for(const [name,content] of Object.entries(outputs)){
    if(check){if(await readFile(resolve(root,name),'utf8')!==content)throw new Error('Stale generated API reference: '+name);}
    else await writeFile(resolve(root,name),content);
  }
  return {businessRoutes:businessApiReference.length,specialRoutes:specialApiReference.length,errorDeclarations:errors.length,sourceFiles:Object.keys(sources).length,check};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(JSON.stringify(await buildApiReference({check:process.argv.includes('--check')})));
