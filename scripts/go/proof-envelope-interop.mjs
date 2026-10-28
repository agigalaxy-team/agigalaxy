process.stdin.setEncoding('utf8');
import {createPrivateKey} from 'node:crypto';
import {signEnvelope} from '../../packages/galaxy-official/src/security/signed-envelope.mjs';
import {verifyEnvelope} from '../../packages/galaxy-official/src/verification/envelope.mjs';
let text='';for await(const c of process.stdin)text+=c;const x=JSON.parse(text),trustedKeys=new Map([[x.kid,{publicKeyPem:x.publicKeyPem,notBefore:x.at-10,notAfter:x.at+100000}]]);
const type=x.kind??'proof';
const token=await signEnvelope({type,issuer:x.endpoint,audience:x.endpoint,kid:x.kid,privateKey:createPrivateKey(x.privateKeyPem),data:x.data,now:x.at,maxAge:x.age,id:x.id});
const opened=await verifyEnvelope(x.token,{type,issuer:x.endpoint,audience:x.endpoint,trustedKeys,now:x.at,maxAge:type==='proof'?86400:300});console.log(JSON.stringify({sameBytes:token===x.token,data:opened.data,expiresAt:opened.expiresAt}));
