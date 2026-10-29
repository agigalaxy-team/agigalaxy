// Current portable signature contract and real A2A SDK loopback fixture.
// No Official service, database, runtime state or secret discovery is involved.
import {verifyEnvelope} from '../../../../packages/galaxy-client/src/verification/envelope.mjs';
import {digest} from '../../../../packages/galaxy-contracts/src/digest.mjs';
import {nodeControlSnapshotSchema,nodeControlEventSchema} from '../../../../packages/galaxy-contracts/src/node-control-proof-schema.mjs';
import {conformanceSnapshotSchema} from '../../../../packages/galaxy-contracts/src/conformance-schema.mjs';
let raw='';for await(const chunk of process.stdin)raw+=chunk;const input=JSON.parse(raw||'null');
if(process.argv[2]==='portable-verify'){
 const {endpoint,clock,builderId,controlId,reportId,publicKeyPem,node,report}=input;
 const options={issuer:endpoint,audience:endpoint,trustedKeys:new Map([['go-fixture',{publicKeyPem,notBefore:clock-1,notAfter:clock+1000,revoked:false}]]),now:clock,maxAge:300};
 const e=await verifyEnvelope(node,{...options,type:'node-control'}),data=nodeControlSnapshotSchema.parse(e.data),control=data.control;
 if(data.id!==e.id||data.id!==controlId||data.builderId!==builderId||control.id!==data.id||control.builderId!==builderId||control.ownerId!==data.ownerId||control.nodeId!==data.nodeId||control.declarationId!==data.declarationId||control.declarationHash!==data.declarationHash||digest(data.controlPayloadJson)!==data.sourceEventHash||JSON.stringify(nodeControlEventSchema.parse(JSON.parse(data.controlPayloadJson)))!==JSON.stringify(control)||data.checkedAt!==e.issuedAt||data.expiresAt!==e.expiresAt||control.expiresAt<data.expiresAt)throw Error('Node control snapshot mismatch');
 const r=await verifyEnvelope(report,{...options,type:'conformance'}),snapshot=conformanceSnapshotSchema.parse(r.data),statement=snapshot.report;
 if(snapshot.id!==r.id||snapshot.id!==statement.id||snapshot.id!==reportId||snapshot.builderId!==builderId||statement.builderId!==snapshot.builderId||statement.declarationId!==snapshot.declarationId||statement.declarationHash!==snapshot.declarationHash||snapshot.reportHash!==digest(JSON.stringify(statement))||snapshot.assessorId===snapshot.ownerId||snapshot.checkedAt!==r.issuedAt||snapshot.expiresAt!==r.expiresAt||statement.observedAt>snapshot.checkedAt||statement.expiresAt<snapshot.expiresAt)throw Error('Conformance snapshot mismatch');
 console.log(JSON.stringify({verified:true}));
}else if(process.argv[2]==='probe-sdk'){
 const {sdkPeer}=await import('../../../../packages/galaxy-a2a/test/sdk-peer.mjs');const peer=await sdkPeer();try{console.log(JSON.stringify(input?{reply:await peer.post(peer.endpoint,{bodyJson:JSON.stringify(input)}),requests:peer.requests}:{card:peer.card}));}finally{await peer.close();}
}else throw Error('mode required');
