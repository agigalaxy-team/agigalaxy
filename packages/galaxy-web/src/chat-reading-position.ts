export type ChatReadingPosition={floor:string|null;anchor:{messageId:string;offset:number}|null;top:number;keyword:string;contexts?:string[]};
type SavedReading={positions:Record<string,ChatReadingPosition>;returns:Record<string,string>};
export function chatReadingState(endpoint:string,subjectId:string,roomId:string|undefined){
 const key='galaxy-chat-reading:'+JSON.stringify([endpoint,subjectId,roomId??'directory']);
 let state:SavedReading={positions:{},returns:{}};
 try{const raw=sessionStorage.getItem(key);if(raw){const value=JSON.parse(raw);if(value&&typeof value==='object'&&value.positions&&value.returns)state=value;}}catch{/* Private reading positions can be unavailable in a restricted browser. */}
 function save(){try{sessionStorage.setItem(key,JSON.stringify(state));}catch{/* Navigation still works without local view storage. */}}
 return{read:(search:string)=>{const value=state.positions[search];if(!value||!Number.isFinite(value.top)||typeof value.keyword!=='string'||value.floor!==null&&(typeof value.floor!=='string'||! /^[1-9][0-9]*$/.test(value.floor))||value.anchor!==null&&(!value.anchor||typeof value.anchor.messageId!=='string'||!Number.isFinite(value.anchor.offset)))return null;return value;},
  write:(search:string,value:ChatReadingPosition)=>{state.positions[search]=value;const keys=Object.keys(state.positions);for(const older of keys.slice(0,Math.max(0,keys.length-24)))delete state.positions[older];save();},
  back:(search:string)=>state.returns[search]??null,
  remember:(destination:string,source:string)=>{state.returns[destination]=source;save();}};
}
export function chatSearchParams(search:string){
 const params=new URLSearchParams(search),message=params.get('message'),after=params.get('after');
 return{keyword:(params.get('q')??'').slice(0,1000),after:after&&/^[0-9]+$/.test(after)?after:'0',message:message&&/^[0-9a-f-]{36}$/i.test(message)?message:undefined,invitation:params.get('invitation')??undefined};
}
export function chatSearchString({keyword='',after='0',message}:{keyword?:string;after?:string;message?:string}){
 const params=new URLSearchParams();if(keyword){params.set('q',keyword);if(after!=='0')params.set('after',after);}if(message)params.set('message',message);return params.size?'?'+params.toString():'';
}
