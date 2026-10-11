// Only the exact loopback review endpoint returned by Native can be opened by
// a trusted host bridge. A URL is a choice surface, never approval evidence.
export function nativeChoiceUrl(value){
 try{const url=new URL(value);return url.protocol==='http:'&&url.hostname==='127.0.0.1'&&!!url.port
  &&!url.username&&!url.password&&!url.search&&!url.hash&&/^\/review\/[a-f0-9]{48}$/.test(url.pathname)?url.href:null;}catch{return null;}
}
