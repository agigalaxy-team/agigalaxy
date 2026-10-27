// Preserve the original management destination without accepting an external
// URL or returning to the login entry itself after authentication.
export function operatorLoginTarget(value){
 if(typeof value!=='string'||value.length>2048||!/^\/(?:admin(?:\/|\?|$)|preview\/pages\/)/.test(value)||/[\r\n\\]/.test(value))return '/admin';
 try{const target=new URL(value,'https://management.invalid');if(target.origin!=='https://management.invalid'||!/^\/(?:admin(?:\/|$)|preview\/pages\/)/.test(target.pathname)||/^\/admin\/login\/?$/.test(target.pathname))return '/admin';return target.pathname+target.search+target.hash;}catch{return '/admin';}
}
export function operatorLoginPage(path,searchParams={}){
 const target=new URL(operatorLoginTarget(path),'https://management.invalid');
 for(const [key,value] of Object.entries(searchParams)){
  if(key==='_rsc')continue;
  const values=typeof value==='string'?[value]:Array.isArray(value)?value.filter(item=>typeof item==='string'):[];
  if(!values.length)continue;
  target.searchParams.delete(key);
  for(const item of values)target.searchParams.append(key,item);
 }
 return '/admin/login?redirect='+encodeURIComponent(operatorLoginTarget(target.pathname+target.search+target.hash));
}
