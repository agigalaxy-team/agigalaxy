import {isIP} from 'node:net';
const loopback=host=>['127.0.0.1','[::1]'].includes(host);
function origin(value,name){
  let url;try{url=new URL(value);}catch{throw Error(name+' must be an absolute origin');}
  if(url.origin!==value||url.username||url.password||!(url.protocol==='https:'||url.protocol==='http:'&&loopback(url.hostname)))throw Error(name+' must use HTTPS or literal loopback HTTP');
  return url.origin;
}
export function adminEnvironment(env=process.env){
  const publicOrigin=origin(env.GALAXY_ADMIN_PUBLIC_ORIGIN,'GALAXY_ADMIN_PUBLIC_ORIGIN');
  const bffOrigin=origin(env.GALAXY_ADMIN_BFF_ORIGIN,'GALAXY_ADMIN_BFF_ORIGIN');
  return {publicOrigin,bffOrigin,fixtureCookies:loopback(new URL(publicOrigin).hostname)&&loopback(new URL(bffOrigin).hostname)};
}
export function operatorCookies(headers,fixtureCookies=false){
  const allowed=new Set(['__Host-galaxy-operator','__Host-galaxy-operator-login',...(fixtureCookies?['galaxy-operator-fixture','galaxy-operator-login-fixture']:[])]);
  return (headers.get('cookie')??'').split(';').map(part=>part.trim()).filter(part=>{
    const at=part.indexOf('=');return at>0&&allowed.has(part.slice(0,at))&&/^[A-Za-z0-9_.~-]{1,4096}$/.test(part.slice(at+1));
  }).join('; ');
}
// The Next listener is loopback-only. Its Caddy edge overwrites this header
// with the client address. Preserve the validated chain for the API's own
// explicit trusted-proxy traversal and per-client request quotas.
export function operatorForwardedAddress(headers,fixtureCookies=false){
  const raw=headers.get('x-forwarded-for');
  if(typeof raw==='string'&&raw.length<=1024){
    const chain=raw.split(',').map(value=>value.trim());
    if(chain.length>0&&chain.length<=16&&chain.every(value=>isIP(value)!==0&&!value.includes('%')))return chain.join(', ');
  }
  if(fixtureCookies&&raw===null)return '127.0.0.1';
  throw Error('operations_forwarded_address_required');
}
