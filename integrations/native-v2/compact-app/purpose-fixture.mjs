// Synthetic message transport only. Native signing, HTTP, current permissions
// and persistence use the existing isolated Official/PGlite service fixture.
// This supplies no evidence for real Prosody delivery or a physical AI host.
export function syntheticMessageTransport(){
 const bodies=new Map();
 return{available:true,project:async()=>{},
  send:async input=>{bodies.set(input.messageId,{archiveId:input.messageId,text:input.text,revision:1});return{archiveId:input.messageId};},
  read:async input=>input.ids.map(id=>bodies.get(id)).filter(Boolean),
  edit:async input=>{const old=bodies.get(input.messageId);if(old)bodies.set(input.messageId,{...old,text:input.text,revision:old.revision+1});return{archiveId:input.messageId};},
  erase:async input=>{bodies.delete(input.messageId);return{archiveDeleted:true};}};
}
