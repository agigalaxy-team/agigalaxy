import {readFile,mkdir,writeFile,readdir} from 'node:fs/promises';
import {resolve,dirname,relative,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

export const repositoryRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function loadComponents(root=repositoryRoot){
 const catalog=JSON.parse(await readFile(join(root,'repository-components.json'),'utf8'));
 const ids=new Set(catalog.components.map(c=>c.id));
 if(catalog.version!==1||ids.size!==catalog.components.length)throw Error('Invalid component catalog.');
 for(const c of catalog.components)if(c.dependsOn.some(id=>!ids.has(id)||id===c.id))throw Error('Invalid component dependency.');
 return catalog;
}
const normalize=value=>value.replaceAll('\\','/').replace(/^\.\//,'');
export function ownerOf(catalog,input){
 const name=normalize(input),exact=catalog.components.find(c=>c.files?.includes(name));if(exact)return exact.id;
 return catalog.components.flatMap(c=>c.roots.map(root=>({id:c.id,root}))).sort((a,b)=>b.root.length-a.root.length)
  .find(item=>name===item.root||name.startsWith(item.root+'/'))?.id??null;
}
export function affectedComponents(catalog,files,imports=[]){
 const changed=files.map(normalize),all=changed.some(name=>catalog.globalInputs.includes(name));
 const impactedFiles=new Set(changed);let imported=true;
 while(imported){imported=false;for(const edge of imports)if(edge.kind==='source'&&!impactedFiles.has(edge.source)&&[...impactedFiles].some(name=>edge.target===name||edge.target+'.ts'===name||edge.target+'.tsx'===name||edge.target+'.mjs'===name)){
  impactedFiles.add(edge.source);imported=true;
 }}
 const direct=new Set(all?catalog.components.map(c=>c.id):[...impactedFiles].map(name=>ownerOf(catalog,name)).filter(Boolean));
 const affected=new Set(direct);let moved=true;
 while(moved){moved=false;for(const c of catalog.components)if(!affected.has(c.id)&&c.dependsOn.some(id=>affected.has(id))){affected.add(c.id);moved=true;}}
 return{direct:[...direct],affected:catalog.components.filter(c=>affected.has(c.id)).map(c=>c.id),
  impactedFiles:[...impactedFiles],unclassified:changed.filter(name=>!ownerOf(catalog,name)&&!catalog.globalInputs.includes(name))};
}
const run=(args,cwd)=>{const r=spawnSync(args[0],args.slice(1),{cwd,stdio:'inherit',windowsHide:true});if(r.error)throw r.error;if(r.status!==0)throw Error('Component command failed: '+r.status);};
function gitFiles(base){const result=spawnSync('git',['diff','--no-renames','--name-only','-z',`${base}...HEAD`],{cwd:repositoryRoot,encoding:'utf8',windowsHide:true});if(result.status!==0)throw Error('Cannot resolve explicit comparison base.');return result.stdout.split('\0').filter(Boolean);}
function ordered(catalog,ids){const result=[],visiting=new Set(),done=new Set();function visit(id){if(done.has(id))return;if(visiting.has(id))throw Error('Component build dependency cycle.');visiting.add(id);const c=catalog.components.find(c=>c.id===id);if(!c)throw Error('Unknown component '+id);for(const dep of c.buildDependsOn??[])visit(dep);visiting.delete(id);done.add(id);result.push(c);}for(const id of ids)visit(id);return result;}

// Static relative imports document real source coupling. This is deliberately
// not an invented package manager; existing manifests/lockfiles stay in place.
export async function componentImports(catalog,root=repositoryRoot){
 const edges=new Map(),missing=[],imports=[];
 async function walk(area){for(const item of await readdir(area,{withFileTypes:true})){if(item.isSymbolicLink()||catalog.sourceExcludedDirectories.includes(item.name))continue;const path=join(area,item.name);
  if(item.isDirectory())await walk(path);else if(/\.(mjs|[cm]?js|tsx?)$/.test(item.name)){const source=normalize(relative(root,path)),from=ownerOf(catalog,source);if(!from)continue;
   const text=await readFile(path,'utf8');for(const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.[^'"]+)['"]/g)){
    const target=normalize(relative(root,resolve(dirname(path),match[1]))),to=ownerOf(catalog,target);
    const kind=source.split('/').some(p=>['test','tests'].includes(p))||/\/(verify-|test-)|\.test\.|-fixture\./.test(source)?'test':'source';
    imports.push({source,target,kind});if(!to||to===from)continue;
    const key=from+'->'+to;if(!edges.has(key))edges.set(key,{from,to,examples:[]});const edge=edges.get(key);if(edge.examples.length<4)edge.examples.push({source,target});
    if(!catalog.components.find(c=>c.id===from).dependsOn.includes(to))missing.push({source,target,from,to});
   }
  }
 }}
 for(const area of ['apps','services','packages','integrations'])try{await walk(join(root,area));}catch(error){if(error.code!=='ENOENT')throw error;}
 return{edges:[...edges.values()],additionalSourceCoupling:missing,imports};
}

async function cli(){
 const [action,...args]=process.argv.slice(2),catalog=await loadComponents();
 const value=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
 if(action==='list'){console.log(JSON.stringify(catalog,null,2));return;}
 if(action==='resources'){
  if(value('--component')!=='hub')throw Error('Runtime resource closure currently belongs to the Hub service family.');
  const {releaseImportResources}=await import('../packages/galaxy-official/src/operations/service-release.mjs');
  console.log(JSON.stringify(await releaseImportResources(repositoryRoot,Object.values(catalog.components.find(c=>c.id==='hub').entries))));return;
 }
 if(action==='plan'){
  const selected=value('--files'),base=value('--base');if(!selected&&!base)throw Error('plan requires --files JSON or --base Git commit.');
  const files=selected?JSON.parse(await readFile(resolve(selected),'utf8')):gitFiles(base),graph=await componentImports(catalog),plan=affectedComponents(catalog,files,graph.imports);
  const result={...plan,include:plan.affected.map(component=>({component})),changedFiles:files.length};
  const output=value('--output');if(output)await writeFile(resolve(output),JSON.stringify(result,null,2)+'\n');else console.log(JSON.stringify(result));return;
 }
 if(action==='imports'){const result=await componentImports(catalog);const output=value('--output');if(output)await writeFile(resolve(output),JSON.stringify(result,null,2)+'\n');else console.log(JSON.stringify(result,null,2));return;}
 if(!['build','check'].includes(action))throw Error('Use list, plan, imports, resources, build or check.');
 const id=value('--component');if(!id)throw Error('Select --component.');
 const outputRoot=resolve(value('--output')??join(repositoryRoot,'outputs','components',crypto.randomUUID()));
 if(outputRoot===repositoryRoot||repositoryRoot.startsWith(outputRoot+'/')||repositoryRoot.startsWith(outputRoot+'\\'))throw Error('Output must be separate from sources.');
 await mkdir(outputRoot,{recursive:true});const records=[];
 // Only site requires a compiled Web artifact; libraries have no output step.
 const selected=action==='build'&&id==='site'?['web','site']:[id];
 for(const component of ordered(catalog,selected).filter(c=>selected.includes(c.id))){
  const destination=join(outputRoot,component.id),receipt=join(outputRoot,component.id+'-release.json');
  const tokens={'{node}':process.execPath,'{python}':process.env.GALAXY_BUILD_PYTHON??(process.platform==='win32'?'python':'python3'),'{output}':destination,'{receipt}':receipt,'{webOutput}':join(outputRoot,'web')};
  const commands=component[action==='build'?'build':'checks'];
  try{for(const command of commands){const argv=command.map(part=>tokens[part]??part);run(argv,resolve(repositoryRoot,component.cwd??'.'));}}
  catch(error){records.push({component:component.id,action,state:'failed',commands:commands.length});await writeFile(join(outputRoot,'result.json'),JSON.stringify({records,deployed:false},null,2)+'\n');throw error;}
  const actualOutput=action==='build'&&component.buildOutput?resolve(repositoryRoot,component.buildOutput):destination;
  records.push({component:component.id,action,commands:commands.length,state:commands.length?'passed':'no-command',output:commands.length?actualOutput:null,limit:component.buildLimit??null});
 }
 await writeFile(join(outputRoot,'result.json'),JSON.stringify({records,deployed:false},null,2)+'\n');console.log(JSON.stringify({outputRoot,records,deployed:false}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await cli();
