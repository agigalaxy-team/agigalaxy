import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {xml} from '@xmpp/component';
import parse from '@xmpp/xml/lib/parse.js';
import {ProsodyChatTransport} from '../src/infrastructure/prosody-chat.mjs';
import {runCommand} from '../deploy/operations-stack/host.mjs';

const info='http://jabber.org/protocol/disco#info',muc='http://jabber.org/protocol/muc';
const rooms='rooms.galaxy.internal',gateway='gateway.galaxy.internal';
const linux={skip:process.platform!=='linux'?'Uses the current fixed Prosody image without network or production mounts.':false};

test('maintenance service-info probe executes native Prosody 13 host discovery before any room or archive lookup and rejects unrelated ACKs',linux,async()=>{
 const image=(await runCommand('/usr/bin/docker',['inspect','--format','{{.Image}}','galaxy-chat-pilot-chat-1'],{timeout:10000,maxOutput:1024})).stdout.trim();
 assert.match(image,/^sha256:[a-f0-9]{64}$/);
 // Actual native host-info handler, event ordering, stanza/XML/caps libraries
 // and MUC identity/feature declarations. Only module services and the socket
 // are explicit doubles. No daemon, credentials, data mount or room is opened.
 const program=`package.path='/usr/local/lib/prosody/?.lua;'..package.path;package.cpath='/usr/local/lib/prosody/?.so;'..package.cpath;dofile('/usr/local/lib/prosody/loader.lua');
 local st=require'prosody.util.stanza';local json=require'prosody.util.json';local events=require'prosody.util.events'.new();
 local calls={rooms=0,archive=0,subjects=0,items=0};local items={identity={},feature={},extension={}};
 package.loaded['prosody.core.hostmanager']={get_children=function()calls.items=calls.items+1;error('items access forbidden')end};
 package.loaded['prosody.core.rostermanager']={is_contact_subscribed=function()calls.subjects=calls.subjects+1;error('subject access forbidden')end};
 module={host='rooms.galaxy.internal'};
 function module:get_option_boolean(_,default)return default end
 function module:get_option_array(_,default)return default end
 function module:get_option_string(_,default)return default end
 function module:get_host_type()return 'component' end
 function module:add_identity(category,kind,name)items.identity[#items.identity+1]={category=category,type=kind,name=name}end
 function module:add_feature(feature)items.feature[#items.feature+1]=feature end
 function module:get_host_items(kind)return items[kind]end
 function module:hook(name,handler,priority)events.add_handler(name,handler,priority)end
 function module:fire_event(name,event)return events.fire_event(name,event)end
 function module:default_permission()end
 function module:open_store()calls.archive=calls.archive+1;error('archive access forbidden')end
 function module:depends(name)assert(name=='disco');assert(loadfile('/usr/local/lib/prosody/modules/mod_disco.lua','t',_ENV))()end
 local file=assert(io.open('/usr/local/lib/prosody/modules/muc/mod_muc.lua'));local source=file:read('*a');file:close();
 local declarations=assert(source:match('(module:depends%("disco"%);.-module:add_feature%("http://jabber.org/protocol/muc"%);)'));
 assert(load(declarations,'@native-muc-service-declarations','t',_ENV))();
 -- The actual MUC room dispatcher is registered at -2; fail if host disco
 -- does not finish before that fallback. Its room store must remain untouched.
 assert(source:match('end, %-2%)'));
 events.add_handler('iq-get/host/http://jabber.org/protocol/disco#info:query',function()calls.rooms=calls.rooms+1;error('room access forbidden')end,-2);
 events.add_handler('host-disco-items',function()calls.items=calls.items+1;error('room listing forbidden')end);
 local request=assert(require'prosody.util.xml'.parse(io.read('*a')));
 assert(request.name=='iq' and request.attr.type=='get' and request.attr.to==module.host and request.attr.from=='gateway.galaxy.internal');
 assert(#request.tags==1 and request.tags[1].name=='query' and request.tags[1].attr.xmlns=='http://jabber.org/protocol/disco#info' and request.tags[1].attr.node==nil);
 local reply;assert(events.fire_event('iq-get/host/http://jabber.org/protocol/disco#info:query',{stanza=request,origin={send=function(value)assert(reply==nil);reply=value end}})==true);
 assert(reply and reply.attr.type=='result' and reply.attr.id==request.attr.id and reply.attr.from==module.host and reply.attr.to==request.attr.from);
 assert(calls.rooms==0 and calls.archive==0 and calls.subjects==0 and calls.items==0);
 print(json.encode({xml=tostring(reply),calls=calls,nativeVersion='13.0.6'}));`;
 const transport=new ProsodyChatTransport({service:'xmpp://127.0.0.1:5347',domain:gateway,roomsDomain:rooms,secret:'synthetic-component-key-not-production',timeoutMs:100});
 await assert.rejects(transport.probe(),{code:'chat_transport_unavailable'});
 transport.client.emit('online');let nativeReply,calls,nativeFailure;
 transport.client.send=async stanza=>{
  try{
  assert.equal(stanza.attrs.type,'get');assert.equal(stanza.attrs.to,rooms);assert.equal(stanza.attrs.from,gateway);assert.equal(stanza.children.length,1);
  const query=stanza.getChild('query',info);assert(query);assert.deepEqual(query.attrs,{xmlns:info});assert.equal(query.children.length,0);
  const executed=spawnSync('/usr/bin/docker',['run','--rm','--interactive','--pull','never','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','64','--memory','128m','--tmpfs','/tmp:rw,nosuid,noexec,size=8m','--entrypoint','/usr/bin/lua',image,'-e',program],{input:stanza.toString(),timeout:30000,maxOutput:32768});
  const diagnostic=executed.stderr?.toString().split('\n')[0].slice(0,300)??'';
  assert.equal(executed.status,0,'isolated native discovery failed: '+diagnostic);
  const result=JSON.parse(executed.stdout.toString());assert.equal(result.nativeVersion,'13.0.6');assert.deepEqual(result.calls,{rooms:0,archive:0,subjects:0,items:0});
  nativeReply=result.xml;calls=result.calls;transport.client.emit('stanza',parse(nativeReply));
  }catch(error){nativeFailure=error;throw error;}
 };
 let observed;try{observed=await transport.probe();}catch(error){throw nativeFailure??error;}
 assert.deepEqual(observed,{authenticatedGateway:true,roomsDomain:rooms,roundTrip:true,readOnly:true,bodyReturned:false});
 assert.equal(transport.pending.size,0);assert.equal(calls.rooms,0);
 // Reuse the real native serialized reply through the actual Node XML parser.
 // Whitespace and additional native service metadata never enter the DTO.
 transport.client.send=async stanza=>{const reply=parse(nativeReply);reply.attrs.id=stanza.attrs.id;reply.children.unshift('\n ');reply.getChild('query',info).children.unshift('\n ');reply.getChild('query',info).append(xml('x',{xmlns:'jabber:x:data',type:'result'}));transport.client.emit('stanza',reply);};
 assert.equal((await transport.probe()).bodyReturned,false);
 for(const change of ['empty','missing-identity','missing-feature','foreign-to','foreign-from','foreign-id','node','items','body','error']){
  transport.client.send=async stanza=>{
   const reply=parse(nativeReply);reply.attrs.id=stanza.attrs.id;const query=reply.getChild('query',info);
   if(change==='empty')reply.children=[];
   if(change==='missing-identity')query.children=query.children.filter(x=>!x?.is?.('identity',info));
   if(change==='missing-feature')query.children=query.children.filter(x=>!x?.is?.('feature',info));
   if(change==='foreign-to')reply.attrs.to='other.galaxy.internal';
   if(change==='foreign-from')reply.attrs.from='other.galaxy.internal';
   if(change==='foreign-id')reply.attrs.id='unrelated-request-id';
   if(change==='node')query.attrs.node='another-node';
   if(change==='items')query.attrs.xmlns='http://jabber.org/protocol/disco#items';
   if(change==='body')reply.append(xml('body',{},'synthetic-message-never-returned'));
   if(change==='error')reply.attrs.type='error';
   transport.client.emit('stanza',reply);
  };
  await assert.rejects(transport.probe(),{code:['foreign-from','foreign-id'].includes(change)?'chat_delivery_unknown':'chat_transport_invalid_reply'});
  assert.equal(transport.pending.size,0);
 }
 transport.client.send=async()=>transport.client.emit('offline');await assert.rejects(transport.probe(),{code:'chat_delivery_unknown'});
 await assert.rejects(transport.probe(),{code:'chat_transport_unavailable'});
});
