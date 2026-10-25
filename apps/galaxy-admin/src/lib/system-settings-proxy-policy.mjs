const base='/v1/operations/system-settings';
const uuid='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
export const systemSettingsReadPath=new RegExp('^'+base+'/(?:overview|mail|service-connections|advanced|general/publication|general/operations/'+uuid+'|(?:mail|service-connections)/history|operations/'+uuid+')$');
export const systemSettingsWritePath=new RegExp('^'+base+'/(?:credentials|(?:mail|service-connections)/(?:versions|test|apply))$');
export function systemSettingsQueryAllowed(pathname,search){
 if(!pathname.startsWith(base))return true;
 if(!systemSettingsReadPath.test(pathname)&&!systemSettingsWritePath.test(pathname))return false;
 if(!pathname.endsWith('/history'))return !search;
 if(search.length>1024)return false;const params=new URLSearchParams(search);
 for(const[key,value]of params){if(params.getAll(key).length!==1)return false;
  if(key==='after'){if(!/^[1-9][0-9]{0,18}$/.test(value)||BigInt(value)>9223372036854775807n)return false;}
  else if(key==='limit'){if(!/^(?:[1-9]|[1-4][0-9]|50)$/.test(value))return false;}
  else return false;
 }return true;
}
