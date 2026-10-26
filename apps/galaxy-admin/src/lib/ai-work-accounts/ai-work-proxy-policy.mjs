const root='/v1/operations/ai-work-accounts';
const domain='(?:overview|governance|messaging|discovery|maintenance)';
const uuid='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
export const aiWorkReadPath=new RegExp('^'+root+'(?:/'+domain+'(?:/(?:history|runtime))?|/operations/'+uuid+')?$');
export const aiWorkWritePath=new RegExp('^'+root+'/'+domain+'/(?:commands|assignments)$');
/** The new account family has no arbitrary domain, method, query or target. */
export function aiWorkQueryAllowed(pathname,search){
 if(!aiWorkReadPath.test(pathname)&&!aiWorkWritePath.test(pathname))return true;
 if(!pathname.endsWith('/history'))return !search;
 if(search.length>1024)return false;
 const params=new URLSearchParams(search);
 for(const[key,value]of params){
  if(params.getAll(key).length!==1)return false;
  if(key==='after'){if(!/^[1-9][0-9]{0,18}$/.test(value)||BigInt(value)>9223372036854775807n)return false;}
  else if(key==='limit'){if(!/^(?:[1-9]|[1-9][0-9]|100)$/.test(value))return false;}
  else return false;
 }
 return true;
}
