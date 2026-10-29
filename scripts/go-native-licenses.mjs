import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,readdir,mkdir,lstat} from 'node:fs/promises';
import {join,dirname,relative,isAbsolute,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const run=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
// The standalone Native binary needs its own Go dependency texts; the outer
// Go core inventory is not part of a separately distributed Native package.
export async function collectGoNativeLicenses({sourceDirectory,destination,goExecutable,goos,goarch}) {
 const cwd=join(sourceDirectory,'go'),env={...process.env,GOOS:goos,GOARCH:goarch,CGO_ENABLED:'0',GOTOOLCHAIN:'local',GOFLAGS:'-mod=readonly'};
 const invoke=args=>run(goExecutable,args,{cwd,env,windowsHide:true,maxBuffer:64*1024*1024});
 const stream=(await invoke(['list','-mod=readonly','-buildvcs=false','-deps','-json','./cmd/galaxy'])).stdout.trim();
 const modules=new Map(),sourceHashes={};
 for(const name of ['go/go.mod','go/go.sum'])sourceHashes[name]=sha(await readFile(join(sourceDirectory,name)));
 for(const part of stream.split(/\r?\n(?=\{)/)){
  const pkg=JSON.parse(part),m=pkg.Module;
  if(m&&!m.Main)modules.set(m.Path+'@'+m.Version,m);
  if(!m?.Main)continue;
  for(const name of [...(pkg.GoFiles??[]),...(pkg.CgoFiles??[]),...(pkg.SFiles??[]),...(pkg.SysoFiles??[]),...(pkg.EmbedFiles??[])]){
   const file=resolve(pkg.Dir,name),source=relative(sourceDirectory,file).replaceAll('\\','/');
   if(isAbsolute(source)||source==='..'||source.startsWith('../'))throw Error('Go Native input escaped source directory');
   sourceHashes[source]=sha(await readFile(file));
  }
 }
 const files={},items=[],missing=[];
 async function save(name,content){await mkdir(dirname(join(destination,name)),{recursive:true});await writeFile(join(destination,name),content,{flag:'wx'});files[name]=sha(content);}
 async function legal(dir,prefix='') {const found=[];for(const entry of await readdir(dir,{withFileTypes:true})){
  if(entry.isSymbolicLink()||['.git','testdata','node_modules'].includes(entry.name))continue;
  const name=prefix?prefix+'/'+entry.name:entry.name;
  if(entry.isDirectory())found.push(...await legal(join(dir,entry.name),name));
  else if(entry.isFile()&&/^(licen[sc]e|copying|notice|copyright)([._-].*)?$/i.test(entry.name))found.push(name);
 }return found.sort();}
 for(const[id,module] of [...modules].sort(([a],[b])=>a.localeCompare(b,'en'))){const selected=module.Replace??module,names=selected.Dir?await legal(selected.Dir):[];if(!names.length)missing.push(id);
  const paths=[];for(const name of names){const target='third-party-licenses/go/'+id+'/'+name;await save(target,await readFile(join(selected.Dir,name)));paths.push(target);}
  items.push({module:module.Path,version:module.Version,sum:module.Sum??null,replacement:module.Replace?{path:selected.Path,version:selected.Version??null}:null,files:paths});
 }
 const goroot=(await invoke(['env','GOROOT'])).stdout.trim();const goLicense=join(goroot,'LICENSE');if(!(await lstat(goLicense)).isFile())throw Error('Go license unavailable');
 await save('third-party-licenses/go/Go/LICENSE',await readFile(goLicense));
 await save('go-dependency-licenses.json',Buffer.from(JSON.stringify({version:1,scope:'standalone-native-go-binary',modules:items,missing},null,2)+'\n'));
 return {files,missing,sourceHashes};
}
