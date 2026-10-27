import {readFile,mkdir,writeFile,readdir,realpath} from 'node:fs/promises';
import {resolve,dirname,relative,join,isAbsolute,sep} from 'node:path';
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
 const name=normalize(input),exact=catalog.components.find(c=>[...(c.files??[]),...(c.sourceEntries??[]),...(c.configurationInputs??[])].includes(name));if(exact)return exact.id;
 return catalog.components.flatMap(c=>c.roots.map(root=>({id:c.id,root}))).sort((a,b)=>b.root.length-a.root.length)
  .find(item=>name===item.root||name.startsWith(item.root+'/'))?.id??null;
}
export function affectedComponents(catalog,files,imports=[]){
 const changed=files.map(normalize),globalInput=name=>catalog.globalInputs.some(input=>name===input||name.startsWith(input+'/')),all=changed.some(globalInput),nonBuildInput=name=>(catalog.nonBuildInputs??[]).some(input=>name===input||name.startsWith(input+'/'));
 const impactedFiles=new Set(changed);let imported=true;
 while(imported){imported=false;for(const edge of imports)if(edge.kind==='source'&&!impactedFiles.has(edge.source)&&[...impactedFiles].some(name=>edge.target===name||edge.target+'.ts'===name||edge.target+'.tsx'===name||edge.target+'.mjs'===name)){
  impactedFiles.add(edge.source);imported=true;
 }}
 const direct=new Set(all?catalog.components.map(c=>c.id):[...impactedFiles].map(name=>ownerOf(catalog,name)).filter(Boolean));
 const affected=new Set(direct);let moved=true;
 while(moved){moved=false;for(const c of catalog.components)if(!affected.has(c.id)&&c.dependsOn.some(id=>affected.has(id))){affected.add(c.id);moved=true;}}
 return{direct:[...direct],affected:catalog.components.filter(c=>affected.has(c.id)).map(c=>c.id),
  impactedFiles:[...impactedFiles],nonBuildInputs:changed.filter(nonBuildInput),unclassified:changed.filter(name=>!ownerOf(catalog,name)&&!globalInput(name)&&!nonBuildInput(name))};
}
const run=(args,cwd)=>{const r=spawnSync(args[0],args.slice(1),{cwd,stdio:'inherit',windowsHide:true});if(r.error)throw r.error;if(r.status!==0)throw Error('Component command failed: '+r.status);};
function gitFiles(base){const result=spawnSync('git',['diff','--no-renames','--name-only','-z',`${base}...HEAD`],{cwd:repositoryRoot,encoding:'utf8',windowsHide:true});if(result.status!==0)throw Error('Cannot resolve explicit comparison base.');return result.stdout.split('\0').filter(Boolean);}
function gitDeletedFiles(base){const args=base?['diff','--no-renames','--diff-filter=D','--name-only','-z',`${base}...HEAD`]:['ls-files','--deleted','-z'];const result=spawnSync('git',args,{cwd:repositoryRoot,encoding:'utf8',windowsHide:true});if(result.status!==0)throw Error('Cannot resolve removed source inputs.');return result.stdout.split('\0').filter(Boolean);}
function ordered(catalog,ids){const result=[],visiting=new Set(),done=new Set();function visit(id){if(done.has(id))return;if(visiting.has(id))throw Error('Component build dependency cycle.');visiting.add(id);const c=catalog.components.find(c=>c.id===id);if(!c)throw Error('Unknown component '+id);for(const dep of c.buildDependsOn??[])visit(dep);visiting.delete(id);done.add(id);result.push(c);}for(const id of ids)visit(id);return result;}

// Static relative imports document real source coupling. This is deliberately
// not an invented package manager; existing manifests/lockfiles stay in place.
export async function componentImports(catalog,root=repositoryRoot){
 const edges=new Map(),missing=[],imports=[];
 async function walk(area){for(const item of await readdir(area,{withFileTypes:true})){if(item.isSymbolicLink()||catalog.sourceExcludedDirectories.includes(item.name))continue;const path=join(area,item.name);
  if(item.isDirectory())await walk(path);else if(/\.(mjs|[cm]?js|tsx?)$/.test(item.name)){const source=normalize(relative(root,path)),from=ownerOf(catalog,source);
   const text=await readFile(path,'utf8');for(const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.[^'"]+)['"]/g)){
    const target=normalize(relative(root,resolve(dirname(path),match[1]))),to=ownerOf(catalog,target);
    const kind=source.split('/').some(p=>['test','tests'].includes(p))||/\/(verify-|test-)|\.test\.|-fixture\./.test(source)?'test':'source';
    imports.push({source,target,kind});if(!from||!to||to===from)continue;
    const key=from+'->'+to;if(!edges.has(key))edges.set(key,{from,to,examples:[]});const edge=edges.get(key);if(edge.examples.length<4)edge.examples.push({source,target});
    if(!catalog.components.find(c=>c.id===from).dependsOn.includes(to))missing.push({source,target,from,to});
   }
  }
 }}
 for(const area of catalog.sourceRoots)try{await walk(join(root,area));}catch(error){if(error.code!=='ENOENT')throw error;}
 return{edges:[...edges.values()],additionalSourceCoupling:missing,imports};
}


// Documentation may have no build consumer. Unmapped engineering inputs must
// stop CI instead of silently producing a successful empty matrix.
export function unmappedEngineeringInputs(plan,deletedFiles=[]){
 const removed=new Set(deletedFiles);
 return plan.unclassified.filter(name=>!removed.has(name)&&!(/\.(md|txt)$/i.test(name)||/^docs\/.*\.(html?|png|jpe?g|webp|gif|svg|ico)$/i.test(name)||/(^|\/)(LICENSE|NOTICE|COPYING)(\.[^/]*)?$/i.test(name)));
}
const within=(base,target)=>{const part=relative(base,target);return part===''||(!isAbsolute(part)&&part!=='..'&&!part.startsWith('..'+sep));};
async function physicalDestination(target){
 let cursor=target;const tail=[];
 while(true){try{return resolve(await realpath(cursor),...tail.reverse());}
  catch(error){if(error.code!=='ENOENT')throw error;const parent=dirname(cursor);if(parent===cursor)throw error;tail.push(relative(parent,cursor));cursor=parent;}}
}
export async function createOutputRoot(outputRoot,root=repositoryRoot){
 const target=resolve(outputRoot),base=resolve(root),physicalRoot=await realpath(base),physicalTarget=await physicalDestination(target);
 for(const [repo,destination] of [[base,target],[physicalRoot,physicalTarget]]){
  if(within(destination,repo)||within(repo,destination)&&!within(join(repo,'outputs'),destination))throw Error('Inside the repository, output must use a new outputs subdirectory.');
 }
 await mkdir(dirname(target),{recursive:true});
 await mkdir(target); // Atomic: a previous result or failed attempt is never reused.
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
  const deletedFiles=gitDeletedFiles(base),blockedInputs=unmappedEngineeringInputs(plan,deletedFiles),result={...plan,removedUnclassified:plan.unclassified.filter(name=>deletedFiles.includes(name)),include:plan.affected.map(component=>({component})),changedFiles:files.length,blockedInputs};
  const output=value('--output');if(output)await writeFile(resolve(output),JSON.stringify(result,null,2)+'\n');else console.log(JSON.stringify(result));if(blockedInputs.length)throw Error('Unmapped engineering inputs: '+blockedInputs.join(', '));return;
 }
 if(action==='imports'){const result=await componentImports(catalog);const output=value('--output');if(output)await writeFile(resolve(output),JSON.stringify(result,null,2)+'\n');else console.log(JSON.stringify(result,null,2));return;}
 if(!['build','check'].includes(action))throw Error('Use list, plan, imports, resources, build or check.');
 const id=value('--component');if(!id)throw Error('Select --component.');
 const outputRoot=resolve(value('--output')??join(repositoryRoot,'outputs','components',crypto.randomUUID()));
 if(outputRoot===repositoryRoot||repositoryRoot.startsWith(outputRoot+'/')||repositoryRoot.startsWith(outputRoot+'\\'))throw Error('Output must be separate from sources.');
 const selected=[id];
 ordered(catalog,selected);
 await createOutputRoot(outputRoot);const records=[];
 // Each application builds its declared runtime; shared libraries are consumed as source.
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
