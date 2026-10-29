const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const root='/v1/operations/autonomy';
const domain='(?:overview|governance|messaging|discovery|maintenance)';
export const autonomyReadPath=new RegExp('^'+root+'/(?:overview|options|settings|tasks(?:/'+uuid+'(?:/operations/'+uuid+')?)?|accounts/'+domain+'/config|operations/'+uuid+')$','i');
export const autonomyWritePath=new RegExp('^'+root+'/(?:enable|settings|tasks(?:/'+uuid+'/(?:control|decisions))?|accounts/'+domain+'/(?:config|run))$','i');
export function autonomyQueryAllowed(pathname,search){
 if(!autonomyReadPath.test(pathname)&&!autonomyWritePath.test(pathname))return true;
 const keys=pathname===root+'/overview'?['days']:pathname===root+'/tasks'?['page','limit','domain','source','state','mode','targetType','targetId']:[];
 const params=new URLSearchParams(search);
 return search.length<=2048&&[...params.keys()].every(key=>keys.includes(key)&&params.getAll(key).length===1);
}
