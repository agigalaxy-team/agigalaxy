/** Site search never forwards the current authentication URL or its parameters. */
export function siteSearchTarget(query,origin=''){
 const text=typeof query==='string'?query.trim().slice(0,160):'';
 const path='/app/find'+(text?'?q='+encodeURIComponent(text):'');
 return origin?new URL(path,origin).href:path;
}
export function bindSiteSearch(form,{origin='https://agigalaxy.org',navigate=target=>window.location.assign(target)}={}){
 const submit=event=>{
  if(event.defaultPrevented)return;
  event.preventDefault();
  navigate(siteSearchTarget(new FormData(form).get('q'),origin));
 };
 form.addEventListener('submit',submit);
 return()=>form.removeEventListener('submit',submit);
}

