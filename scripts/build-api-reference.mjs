import { readFile,writeFile,readdir } from 'node:fs/promises';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { resolve,relative } from 'node:path';
import { businessApiReference,specialApiReference } from './reference/http-api-entries.mjs';
import { readMigrations } from '../go/internal/databaseschema/generate.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
async function sourceFiles(directory){const files=[];for(const entry of await readdir(directory,{withFileTypes:true})){
  if(entry.isDirectory())files.push(...await sourceFiles(resolve(directory,entry.name)));
  else if(entry.name.endsWith('.go')&&!entry.name.endsWith('_test.go'))files.push(resolve(directory,entry.name));
}return files.sort((a,b)=>a<b?-1:a>b?1:0);}
export async function buildApiReference({check=false}={}) {
  const errors=[];
  const migrations=await readMigrations();
  for(const path of await sourceFiles(resolve(root,'go'))){
    const name=relative(root,path).replaceAll('\\','/'),source=await readFile(path,'utf8');
    // A literal index only: dynamic fault helpers and route reachability are
    // intentionally not inferred from this source scan.
    for(const match of source.matchAll(/\bfault\.New\(\s*"([^"\\]*)"\s*,\s*(\d+)\s*\)/g))
      errors.push({code:match[1],status:Number(match[2]),source:name,line:source.slice(0,match.index).split('\n').length});
  }
  const entries=[...businessApiReference,...specialApiReference];
  // Track only the files contributing literal declarations, rather than a
  // whole-Go source fingerprint that invalidates API docs on unrelated edits.
  const sources=[...new Set(errors.map(error=>error.source))];
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
  return {businessRoutes:businessApiReference.length,specialRoutes:specialApiReference.length,errorDeclarations:errors.length,sourceFiles:sources.length,check};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(JSON.stringify(await buildApiReference({check:process.argv.includes('--check')})));
