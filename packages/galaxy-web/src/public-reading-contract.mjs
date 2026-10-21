import contract from '../../../apps/galaxy-site/public-reading-contract.json' with {type:'json'};

const tags=new Set(contract.tags),attributes=new Set(contract.attributes),routes=new Set(contract.routes);
const version='(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)';
const guide=new RegExp('^/docs/(?:native-client/'+version+'/(?:installation|hosts|runtime)|web/'+version+'/community)/$');
const cmsPath=path=>typeof path==='string'&&/^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)+$/.test(path)&&path.length<=300
  &&!['app','admin','api','v1','v2','preview','assets','media','archives','releases','docs','downloads','404'].includes(path.split('/')[1]);
let routeLoading;
export function loadPublicReadingRoutes(){
  return routeLoading??=fetch('/cms-routes.json',{headers:{accept:'application/json'}}).then(async response=>{
    if(!response.ok)return;
    if(Number(response.headers.get('content-length'))>65536)return;
    const value=await response.json();
    if(value?.version!==1||!Array.isArray(value.routes)||value.routes.length>200||value.routes.some(path=>!cmsPath(path)&&!routes.has(path)))return;
    for(const path of value.routes)routes.add(path);
  }).catch(()=>{});
}
export function publicReadingPath(path){return path.endsWith('/')?path:path+'/';}
export function isPublicReadingRoute(path){const value=publicReadingPath(path);return routes.has(value)||guide.test(value)
  ||cmsPath(value)&&globalThis.__GALAXY_PUBLIC_PAGE__?.path===value;}
export function publicReadingDataUrl(path){
  if(!isPublicReadingRoute(path))throw Error('Unsupported public reading route');
  return '/assets/public-pages'+publicReadingPath(path)+'index.json';
}
function safeUrl(value){
  if(typeof value!=='string'||value.startsWith('//')||value.includes('\\'))return false;
  for(let index=0;index<value.length;index++){const code=value.charCodeAt(index);if(code<=32||code===127)return false;}
  if(value.startsWith('/')||value.startsWith('#'))return true;
  try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password;}catch{return false;}
}

/** Both renderers accept only this small, non-executable document vocabulary. */
export function validatePublicReadingPage(value,path){
  if(!value||typeof value!=='object'||value.version!==contract.version||value.path!==publicReadingPath(path)
    ||!isPublicReadingRoute(value.path)||typeof value.title!=='string'||typeof value.description!=='string'
    ||typeof value.location!=='string'||!Array.isArray(value.behaviors)||value.behaviors.length)throw Error('Invalid public reading page');
  let nodes=0,textLength=0;
  function visit(node,depth){
    if(++nodes>contract.maxNodes||depth>contract.maxDepth)throw Error('Public reading page exceeds its limits');
    if(typeof node==='string'){textLength+=node.length;if(textLength>contract.maxTextLength)throw Error('Public reading text exceeds its limit');return;}
    if(!node||typeof node!=='object'||!tags.has(node.tag)||!node.attrs||typeof node.attrs!=='object'||Array.isArray(node.attrs)||!Array.isArray(node.children))throw Error('Invalid public reading node');
    if(Object.keys(node).some(key=>!['tag','attrs','children'].includes(key)))throw Error('Unknown public reading field');
    for(const [name,content] of Object.entries(node.attrs)){
      if(!attributes.has(name)||typeof content!=='string'||name==='href'&&!safeUrl(content)
        ||['src','alt','loading','decoding'].includes(name)&&node.tag!=='img')throw Error('Unsafe public reading attribute');
    }
    if(node.tag==='img'&&(!/^\/media\/cms\/[a-zA-Z0-9_-]+\/(?:[a-zA-Z0-9._~-]|%[0-9A-Fa-f]{2})+$/.test(node.attrs.src??'')
      ||typeof node.attrs.alt!=='string'||node.attrs.loading!=='lazy'||node.attrs.decoding!=='async'
      ||['width','height'].some(name=>node.attrs[name]!==undefined&&!/^[1-9][0-9]{0,5}$/.test(node.attrs[name]))||node.children.length))throw Error('Unsafe public reading image');
    for(const child of node.children)visit(child,depth+1);
  }
  for(const key of ['sidebar','body','footer']){if(!Array.isArray(value[key]))throw Error('Missing public reading content');for(const node of value[key])visit(node,0);}
  return value;
}

const pages=new Map();
export function initialPublicReadingPage(path){
  const initial=globalThis.__GALAXY_PUBLIC_PAGE__;
  if(initial?.path===publicReadingPath(path)){
    try{pages.set(initial.path,validatePublicReadingPage(initial,path));routes.add(initial.path);}catch{/* Keep the readable initial HTML when bootstrap data is unusable. */}
    delete globalThis.__GALAXY_PUBLIC_PAGE__;
  }
  return pages.get(publicReadingPath(path))??null;
}
export async function loadPublicReadingPage(path,{signal}={}){
  const existing=initialPublicReadingPage(path);if(existing)return existing;
  const response=await fetch(publicReadingDataUrl(path),{signal,headers:{accept:'application/json'}});
  if(!response.ok)throw Error('这份说明暂时无法读取，可以重试或返回原来的页面。');
  if(Number(response.headers.get('content-length'))>2000000)throw Error('Public reading response exceeds its limit');
  const value=validatePublicReadingPage(await response.json(),path);pages.set(value.path,value);return value;
}
