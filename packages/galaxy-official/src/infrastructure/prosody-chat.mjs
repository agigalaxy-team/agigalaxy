import { component,xml } from '@xmpp/component';
import { randomUUID } from 'node:crypto';
import { ServiceError } from '../shared/service-error.mjs';
const ns='urn:galaxy:rooms:2';

// One private XEP-0114 component. Native MUC/MAM provides delivery/storage;
// this protocol only applies authenticated Galaxy metadata and archive policy.
export class ProsodyChatTransport {
 constructor({service,domain,roomsDomain,secret,timeoutMs=4000}){
  const url=new URL(service);
  if(url.protocol!=='xmpp:'||!['127.0.0.1','[::1]','localhost'].includes(url.hostname)||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))throw new Error('Private loopback XMPP component required');
  if(typeof domain!=='string'||!domain||!roomsDomain||domain===roomsDomain||typeof secret!=='string'||secret.length<32)throw new Error('Invalid chat component configuration');
  this.domain=domain;this.roomsDomain=roomsDomain;this.timeoutMs=timeoutMs;this.available=false;this.pending=new Map();
  this.client=component({service,domain,password:secret});
  this.client.on('online',()=>{this.available=true;});
  this.client.on('offline',()=>{this.available=false;this.rejectPending();});
  this.client.on('error',()=>{this.available=false;this.rejectPending();});
  this.client.on('stanza',stanza=>{
   if(!stanza.is('iq')||stanza.attrs.from!==this.roomsDomain)return;
   const p=this.pending.get(stanza.attrs.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(stanza.attrs.id);
   try{if(stanza.attrs.type!=='result')throw new Error();const text=stanza.getChildText('result',ns);const value=JSON.parse(text);
    if(value.error)p.reject(new ServiceError(value.error,409));else p.resolve(value);
   }catch{p.reject(new ServiceError('chat_transport_invalid_reply',502));}
  });
 }
 rejectPending(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new ServiceError('chat_delivery_unknown',504));}this.pending.clear();}
 start(){return this.client.start();}
 async stop(){this.available=false;this.rejectPending();await this.client.stop();}
 async command(action,input){if(!this.available)throw new ServiceError('chat_transport_unavailable',503);const id=randomUUID();
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new ServiceError('chat_delivery_unknown',504));},this.timeoutMs);
   this.pending.set(id,{resolve,reject,timer});
   this.client.send(xml('iq',{type:'set',id,from:this.domain,to:this.roomsDomain},xml('command',{xmlns:ns},JSON.stringify({action,...input}))))
    .catch(()=>{clearTimeout(timer);this.pending.delete(id);reject(new ServiceError('chat_delivery_unknown',504));});
  });
 }
 project(x){return this.command('project',x);}
 send(x){return this.command('send',x);}
 async read(x){return(await this.command('read',x)).messages;}
 async exportOwn(x){return(await this.command('export-own',x)).messages;}
 edit(x){return this.command('edit',x);}
 erase(x){return this.command('erase',x);}
}
