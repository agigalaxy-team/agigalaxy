package identity

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPortableTrustFixedPurposes(t *testing.T) {
	pub, key, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	public, _ := PublicPEM(pub)
	// Full packages have their own bounded schema and can exceed a control event.
	payload := "{\n\"text\":\"" + strings.Repeat("synthetic", 4000) + "\"}\n"
	token, _ := SignIdentityPayload(key, payload, "galaxy-trust-package-v1+jws")
	if e = VerifyTrustPackageSignature(token, public, payload); e != nil {
		t.Fatal(e)
	}
	consent, _ := SignIdentityPayload(key, " {\"consent\":true} \n", "galaxy-consent+jws")
	text, e := OpenTrustConsentSignature(consent, public)
	if e != nil || text != " {\"consent\":true} \n" {
		t.Fatal("exact consent text", e)
	}
	if _, e = OpenTrustConsentSignature(token, public); e == nil {
		t.Fatal("package accepted as consent")
	}
	if e = VerifyTrustPackageSignature(consent, public, " {\"consent\":true} \n"); e == nil {
		t.Fatal("consent accepted as package")
	}
	invalid, _ := SignIdentityPayload(key, string([]byte{0xff}), "galaxy-consent+jws")
	if _, e = OpenTrustConsentSignature(invalid, public); e == nil {
		t.Fatal("invalid UTF8 consent")
	}
}

// The original JavaScript verifier supplies both accepted results and refusals.
// Every key and history is generated for this isolated test, without a database.
func TestControlChainOriginalInterop(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "../../.."))
	script := `
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import {createGalaxyGenesis} from './packages/galaxy-core/src/galaxy-guid.mjs';
import {controlEventHash,controlKeyId} from './packages/galaxy-official/src/domain/identity-control.mjs';
import {verifyIdentityControlChain} from './packages/galaxy-official/src/verification/identity-control.mjs';
const key=()=>{const x=generateKeyPairSync('ed25519');return {private:x.privateKey,public:x.publicKey.export({type:'spki',format:'pem'})}};
const a=key(),b=key(),r=key(),c=key(),r2=key(),d=key();
const genesis=createGalaxyGenesis({publicKeyPem:a.public,originCode:'5',issuedAtMs:2000000000000});
const state={subjectId:genesis.id,genesisProof:genesis.genesisProof,events:[]};
const sig=(k,text)=>{const h=Buffer.from(JSON.stringify({alg:'Ed25519',typ:'galaxy-identity-control-v2+jws'})).toString('base64url'),p=Buffer.from(text).toString('base64url'),input=h+'.'+p;return input+'.'+sign(null,Buffer.from(input),k.private).toString('base64url')};
let epoch=0,head=null;const samples=[];
async function sample(name,input){try{samples.push({name,input:structuredClone(input),expected:await verifyIdentityControlChain(input)})}catch{samples.push({name,input:structuredClone(input),invalid:true})}}
async function push(kind,k,extra={},newKey=null){const request={version:2,operationId:randomUUID(),subjectId:state.subjectId,expectedEpoch:epoch,previousEventHash:head,signerKeyId:controlKeyId(k.public),kind,...extra};
const text=JSON.stringify({version:2,type:'identity-control',audience:'https://isolated.example.invalid',request},null,1);
if(kind==='bootstrap'||kind==='recover')epoch++;
const row={id:request.operationId,subject_id:state.subjectId,sequence:state.events.length+1,epoch,kind,previous_event_hash:head,payload_text:text,controller_signature:sig(k,text),new_device_proof:newKey?sig(newKey,text):null,signer_key_id:request.signerKeyId,accepted_at:'2033-05-18T03:33:20.123Z'};
row.event_hash=controlEventHash({id:row.id,subjectId:row.subject_id,sequence:row.sequence,epoch:row.epoch,kind:row.kind,previousEventHash:row.previous_event_hash,payloadText:row.payload_text,controllerSignature:row.controller_signature,newDeviceProof:row.new_device_proof,signerKeyId:row.signer_key_id,acceptedAt:row.accepted_at});head=row.event_hash;state.events.push(row);await sample(kind,state);}
const device=(k,scopes)=>({deviceId:randomUUID(),publicKeyPem:k.public,scopes});
await sample('empty',state);
await push('bootstrap',a,{genesisProof:genesis.genesisProof,newDevice:device(a,['manage-identity','consent','data-delete'])},a);
await push('authorize-device',a,{newDevice:device(b,['data-delete'])},b);
await push('set-recovery',a,{recoveryGeneration:0,nextRecoveryPublicKey:r.public,saveDeclaration:true});
await push('declare-recovery-saved',a,{recoveryGeneration:1,saveDeclaration:true});
await push('revoke-device',a,{deviceId:JSON.parse(state.events[1].payload_text).request.newDevice.deviceId});
await push('authorize-device',a,{newDevice:device(b,['data-delete'])},b);
await push('recover',r,{recoveryGeneration:1,newDevice:device(c,['manage-identity','consent','data-delete']),nextRecoveryPublicKey:r2.public},c);
await push('authorize-device',c,{newDevice:device(d,['data-delete'])},d);
const numericDates=structuredClone(state);for(const row of numericDates.events)row.accepted_at=2000000000123;await sample('numeric-dates',numericDates);
for(const [name,mutate] of [
 ['wrong-subject',s=>s.subjectId=genesis.id.slice(0,-1)+'0'],
 ['fractional-row',s=>s.events.at(-1).epoch+=0.5],
 ['changed-payload',s=>s.events.at(-1).payload_text+=' '],
 ['wrong-proof',s=>s.events.at(-1).new_device_proof=s.events.at(-1).controller_signature],
 ['changed-head',s=>s.events.at(-1).previous_event_hash='0'.repeat(64)],
 ['genesis-extra',s=>s.genesisProof.extra=true]]){const x=structuredClone(state);mutate(x);await sample(name,x)}
const rewrite=async(name,at,change)=>{const x=structuredClone(samples.find(s=>s.name===at).input),row=x.events.at(-1),env=JSON.parse(row.payload_text);change(env.request,env);row.payload_text=JSON.stringify(env);const signer=at==='recover'?r:at==='authorize-device'?c:a;row.controller_signature=sig(signer,row.payload_text);if(env.request.newDevice)row.new_device_proof=sig(at==='recover'?c:at==='authorize-device'?d:a,row.payload_text);row.event_hash=controlEventHash({id:row.id,subjectId:row.subject_id,sequence:row.sequence,epoch:row.epoch,kind:row.kind,previousEventHash:row.previous_event_hash,payloadText:row.payload_text,controllerSignature:row.controller_signature,newDeviceProof:row.new_device_proof,signerKeyId:row.signer_key_id,acceptedAt:row.accepted_at});await sample(name,x)};
await rewrite('empty-recovery-key','set-recovery',q=>q.nextRecoveryPublicKey='');
await rewrite('fractional-generation','set-recovery',q=>q.recoveryGeneration=0.5);
await rewrite('wrong-recovery-generation','recover',q=>q.recoveryGeneration=0);
await rewrite('truthy-audience','recover',(q,e)=>e.audience=true);
await rewrite('unknown-request-field','bootstrap',q=>q.unknown=true);
console.log(JSON.stringify(samples));
`
	cmd := exec.Command("node", "--input-type=module", "-e", script)
	cmd.Dir = root
	raw, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original verifier: %v: %s", e, raw)
	}
	var samples []struct {
		Name     string
		Input    json.RawMessage
		Expected json.RawMessage
		Invalid  bool
	}
	if e = json.Unmarshal(raw, &samples); e != nil {
		t.Fatal(e)
	}
	for _, s := range samples {
		t.Run(s.Name, func(t *testing.T) {
			out, e := VerifyControlChain(s.Input)
			if s.Invalid {
				if e == nil {
					t.Fatal("accepted original refusal")
				}
				return
			}
			if e != nil {
				t.Fatal(e)
			}
			got, _ := json.Marshal(out)
			var a, b any
			_ = json.Unmarshal(got, &a)
			_ = json.Unmarshal(s.Expected, &b)
			aa, _ := json.Marshal(a)
			bb, _ := json.Marshal(b)
			if string(aa) != string(bb) {
				t.Fatalf("shared=%s original=%s", aa, bb)
			}
		})
	}
}
