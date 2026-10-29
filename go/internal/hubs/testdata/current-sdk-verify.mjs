import {verifyEnvelope} from '../../../../packages/galaxy-client/src/verification/envelope.mjs';
let raw='';for await(const part of process.stdin)raw+=part;const input=JSON.parse(raw),pin=input.pin;
const trustedKeys=new Map([['go-fixture',{...pin,revoked:false}]]),context={issuer:input.endpoint,audience:input.endpoint,trustedKeys,now:2000000000};
const outer=await verifyEnvelope(input.outer,{...context,type:'hub-peering',maxAge:120});
const proof=await verifyEnvelope(input.proof,{...context,type:'proof',maxAge:86400});
if(!outer.data.items?.some(item=>item.signed===input.proof)||!proof.data)throw Error('peer proof missing from signed response');
console.log(JSON.stringify({verified:true}));
