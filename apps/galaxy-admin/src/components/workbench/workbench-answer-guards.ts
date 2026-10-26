type Field={id:string;label:string;type:'text'|'select';options?:string[]};
type ReplyForm={title:string;fields:Field[]};
const text=(value:unknown,max:number)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
export function readReplyForm(source:string):ReplyForm|null{
  if(source.length>8000)return null;
  try{
    const value=JSON.parse(source);
    if(!value||Object.keys(value).some(key=>!['title','fields'].includes(key))||!text(value.title,100)||!Array.isArray(value.fields)||value.fields.length<1||value.fields.length>8)return null;
    const used=new Set<string>();
    for(const field of value.fields){
      if(!field||Object.keys(field).some(key=>!['id','label','type','options'].includes(key))||typeof field.id!=='string'||!/^\w{1,40}$/.test(field.id)||used.has(field.id)||Object.hasOwn(Object.prototype,field.id)||!text(field.label,100)||!['text','select'].includes(field.type))return null;
      if(/password|api.?key|secret|access.?token|密码|口令|密钥|访问令牌/i.test(field.id+' '+field.label))return null;
      if(field.type==='select'&&(!Array.isArray(field.options)||field.options.length<2||field.options.length>8||field.options.some((item:unknown)=>!text(item,160))||new Set(field.options).size!==field.options.length))return null;
      if(field.type==='text'&&field.options!==undefined)return null;
      used.add(field.id);
    }
    return value;
  }catch{return null;}
}

export function diagramSourceAllowed(source:string){
  return source.length<=8000&&/^(?:flowchart|graph)\s+(?:TD|TB|LR|RL|BT)\b|^mindmap\b/.test(source.trim())
    &&!/(?:%%\{|^---|\b(?:click|href|classDef|linkStyle|style|image|icon)\b|<|>\s*script)/im.test(source);
}
