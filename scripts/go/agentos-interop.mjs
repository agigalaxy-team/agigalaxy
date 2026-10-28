import {conversationStreamEvent} from '../../packages/galaxy-official/src/operations/agentos/conversation-stream.mjs';
import {createHmac,timingSafeEqual} from 'node:crypto';
process.stdin.setEncoding('utf8');
let raw='';for await(const chunk of process.stdin)raw+=chunk;
const input=JSON.parse(raw);
if(input.kind==='frames'){
 process.stdout.write(JSON.stringify(input.cases.map(row=>conversationStreamEvent(row.frame,{runId:row.runId,after:row.after}))));
}else if(input.kind==='token'){
 const [head,body,signature]=input.token.split('.'),claims=JSON.parse(Buffer.from(body,'base64url'));
 const expected=createHmac('sha256',input.key).update(head+'.'+body).digest(),actual=Buffer.from(signature,'base64url');
 process.stdout.write(JSON.stringify({valid:actual.length===expected.length&&timingSafeEqual(actual,expected),claims}));
}else throw Error('unknown isolated AgentOS fixture');
