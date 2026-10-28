package native

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestIdentityGroupOriginalZodOrderAndUnicodeBounds(t *testing.T) {
	root, _ := filepath.Abs("../../..")
	script := `
import {identityGroupIntentSchema,identityGroupSubmitSchema} from './packages/galaxy-official/src/shared/identity-group-v2-schema.mjs';
const a='GUID15'+'0'.repeat(26),b=a.slice(0,-1)+'1',id='10000000-0000-4000-8000-000000000001',op='10000000-0000-4000-8000-000000000002',source={originalSubjectId:a,sourceHash:'a'.repeat(64),caseId:id,version:1,id,kind:'case-event'};
const base={accessGranted:false,capabilityMerged:false,purpose:'canonical-display-only',attributionCorrections:[{reason:'中文<>&\u2028\ud800',displaySubjectId:b,source}],sourceRefs:[source],viewers:[],visibility:'Private',canonicalDisplayId:a,memberIds:[a,b],kind:'create',expiresAt:2000000300,issuedAt:2000000000,previousOperationId:null,expectedVersion:0,endpoint:'https://isolated.example.invalid',groupId:id,operationId:op,schemaVersion:2};
const samples=[];for(const reason of ['中文<>&\u2028\ud800','😀'.repeat(800),'😀'.repeat(801)]){const input=structuredClone(base);input.attributionCorrections[0].reason=reason;const parsed=identityGroupIntentSchema.safeParse(input);samples.push({input,valid:parsed.success,payload:parsed.success?JSON.stringify(parsed.data):null})};
for(const reason of ['😀'.repeat(800),'😀'.repeat(801)]){const input={schemaVersion:2,operationId:op,groupId:id,endpoint:base.endpoint,expectedVersion:1,previousOperationId:id,issuedAt:2000000000,expiresAt:2000000300,kind:'revoke',reason};const parsed=identityGroupIntentSchema.safeParse(input);samples.push({input,valid:parsed.success,payload:parsed.success?JSON.stringify(parsed.data):null})}
if(!identityGroupSubmitSchema.safeParse({payloadJson:'😀'.repeat(100000),proofJson:'{}',signature:'x'}).success)throw Error('actual local Zod version changed');
console.log(JSON.stringify(samples));`
	cmd := exec.Command("node", "--input-type=module", "-e", script)
	cmd.Dir = root
	raw, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original schema: %v %s", e, raw)
	}
	var rows []struct {
		Input   json.RawMessage
		Valid   bool
		Payload string
	}
	if e = json.Unmarshal(raw, &rows); e != nil {
		t.Fatal(e)
	}
	for i, row := range rows {
		input, e := jstext.DecodeJSON(row.Input)
		if e != nil {
			t.Fatal(e)
		}
		payload, e := groupIntentText(input)
		if (e == nil) != row.Valid {
			t.Fatalf("case %d acceptance: %v", i, e)
		}
		if row.Valid && payload != row.Payload {
			t.Fatalf("case %d raw intent differs: Go=%s JS=%s", i, payload, row.Payload)
		}
	}
}
