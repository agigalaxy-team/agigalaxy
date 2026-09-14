import { generateKeyPairSync } from 'node:crypto';
import { ManifestService, hubManifestDigest } from '../src/manifest.mjs';
export const hubProfile={networkType:'hub',displayName:'Synthetic Hub',serviceVersion:'0.2.0',
  hub:{profile:'galaxy-hub/1',charter:'https://hub.example.org/charter',scope:'Synthetic coding assistance',
    exit:'Revoke this endpoint binding and remove its local configuration.',export:'Export your selected records before leaving.'}};
export function hubDeclaration(data){return {type:'hub',name:data.displayName,operator:data.operator,region:data.region,scope:data.hub.scope,
  policy:data.policy.url,charter:data.hub.charter,endpoint:data.endpoint,exit:data.hub.exit,export:data.hub.export,
  manifest:{url:data.endpoint+'/.well-known/galaxy-network.json',specVersion:data.hub.profile,sha256:hubManifestDigest(data)},
  contact:data.endpoint+'/contact',redactionConfirmed:true,proofIds:[],release:{version:data.serviceVersion,buildHash:'a'.repeat(64),sourceCommit:'b'.repeat(40),
    artifact:data.endpoint+'/client.tgz',dependencies:[],upgrade:'Keep the same identity.',rollback:'Restore the previous build.'}};}
export function hubManifestFixture(){
  const key=generateKeyPairSync('ed25519');let now=2000000000;
  const bindings={endpoint:'https://hub.example.org',kid:'hub-fixture',signingKey:key.privateKey,now:()=>now,
    trustedKeys:new Map([['hub-fixture',{publicKeyPem:key.publicKey.export({type:'spki',format:'pem'}),notBefore:now-1,notAfter:now+10000,revoked:false}]])};
  const manifest=new ManifestService({...hubProfile,bindings,operator:'Synthetic operator',region:'test',capabilities:['binding','sessions','docs-mcp']});
  return {bindings,manifest,setTime:value=>{now=value;}};
}
