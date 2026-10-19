// Credentials are never work material, even at the highest upload level.
// Exclusion metadata contains locations/categories only, never the removed value.
const excluded='[excluded credential]';
const credentialField=/^(?:password|passwd|pwd|passphrase|secret|clientsecret|apikey|accesskey|secretaccesskey|accesskeyid|accesstoken|refreshtoken|idtoken|token|authorization|proxyauthorization|cookie|setcookie|privatekey|privatekeypem|credentials|credential|env|processenv|environmentvariables)$/i;
const safeField=key=>/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(key)?key:'[field]';

export function redactLocalWorkData(input) {
  const exclusions=[],seen=new WeakSet();
  const omit=(path,kind)=>{exclusions.push({path,kind});return kind==='credential'?excluded:'[excluded '+kind+']';};
  function text(value,path) {
    let changed=false;
    const remove=()=>{changed=true;return excluded;};
    let result=value.replace(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g,remove);
    result=result.replace(/\b(?:Bearer\s+[A-Za-z0-9_.~+\/-]{8,}=*|Basic\s+[A-Za-z0-9+/]{8,}={0,2}|github_pat_[A-Za-z0-9_]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{16})\b/g,remove);
    result=result.replace(/(["']?(?:password|passwd|passphrase|api[_ -]?key|secret[_ -]?access[_ -]?key|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token|密码|口令|私钥)["']?\s*(?:[:=：]|\bis\b)\s*)(?!\[excluded credential\])(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;"'\r\n]+)/gi,(_all,prefix)=>{
      const tail=_all.slice(prefix.length).replace(/^["']|["']$/g,'');if(tail===excluded)return _all;
      changed=true;return prefix+excluded;
    });
    result=result.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,(_all,prefix)=>{changed=true;return prefix+excluded+'@';});
    result=result.replace(/(--(?:api-key|password|passwd|token|client-secret|private-key)(?:=|\s+))(?!\[excluded credential\])(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;"'\r\n]+)/gi,(_all,prefix)=>{changed=true;return prefix+excluded;});
    result=result.replace(/([?&](?:token|key|api[_-]?key|access[_-]?token|client[_-]?secret)=)(?!\[excluded credential\])[^&#\s]+/gi,(_all,prefix)=>{changed=true;return prefix+excluded;});
    if(changed)exclusions.push({path,kind:'credential'});
    if(/^data:[^,]*;base64,/i.test(result))return omit(path,'inline-binary');
    return result;
  }
  function walk(value,path,depth) {
    if(depth>48)return omit(path,'depth-limit');
    if(typeof value==='string')return text(value,path);
    if(value===null||typeof value!=='object')return value;
    if(seen.has(value))return omit(path,'cyclic-reference');
    if(ArrayBuffer.isView(value)||value instanceof ArrayBuffer)return omit(path,'inline-binary');
    seen.add(value);
    try {
      if(Array.isArray(value))return value.map((item,index)=>walk(item,path+'['+index+']',depth+1));
      if(value.kty&&(Object.hasOwn(value,'d')||Object.hasOwn(value,'k')))return omit(path,'credential');
      const result=Object.create(null);
      for(const [key,item]of Object.entries(value)) {
        const location=path+'.'+safeField(key),canonical=key.replace(/[-_\s]/g,'');
        result[key]=credentialField.test(canonical)&&item!==excluded?omit(location,'credential'):walk(item,location,depth+1);
      }
      return result;
    } finally {seen.delete(value);}
  }
  return {value:walk(input,'$',0),exclusions};
}

export function assertNoWorkCredentials(value) {
  if(redactLocalWorkData(value).exclusions.some(item=>item.kind==='credential'))
    throw Object.assign(new Error('local_work_credentials_excluded'),{code:'local_work_credentials_excluded'});
  return value;
}
