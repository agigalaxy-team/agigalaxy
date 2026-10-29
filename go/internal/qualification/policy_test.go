package qualification

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestOriginalPolicyNormalizationAndDefinitionHash(t *testing.T) {
	base := Object{"id": "case-support", "version": "1.0", "capabilityId": "code", "title": " Explicit policy ", "collaboration": "open-assistance", "notBefore": 0, "notAfter": 2100000000, "minProofs": 0, "minAcceptedCollaborations": 0, "historyWindowSeconds": 3600, "requireCiSuccess": false, "repositories": []any{Object{"owner": "OWNER", "repository": "a_b"}, Object{"owner": "owner", "repository": "a-b"}, Object{"owner": "Owner", "repository": "A_B"}, Object{"owner": "owner", "repository": "a.b"}}}
	inputs := []Object{base}
	for _, mutate := range []func(Object){func(p Object) { p["collaboration"] = "basic-bounty" }, func(p Object) { p["notAfter"] = 0 }, func(p Object) { p["historyWindowSeconds"] = 31536001 }, func(p Object) { p["extra"] = true }, func(p Object) { p["minProofs"] = 1; p["repositories"] = []any{} }, func(p Object) { p["minAcceptedCollaborations"] = 17 }} {
		value := cloneValue(base).(map[string]any)
		mutate(value)
		inputs = append(inputs, value)
	}
	root, _ := filepath.Abs("../../..")
	raw, _ := json.Marshal(inputs)
	script := `import {qualificationPolicySchema} from './packages/galaxy-contracts/src/qualification-schema.mjs';let text='';for await(const c of process.stdin)text+=c;console.log(JSON.stringify(JSON.parse(text).map(input=>{try{return{accepted:true,policy:qualificationPolicySchema.parse(input)}}catch{return{accepted:false}}})))`
	cmd := exec.Command("node", "--input-type=module", "-e", script)
	cmd.Dir = root
	cmd.Stdin = bytes.NewReader(raw)
	output, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("current policy schema %v %s", e, output)
	}
	captured, e := os.ReadFile("policy-capture.json")
	if e != nil {
		t.Fatal(e)
	}
	var hashes []struct{ DefinitionHash string }
	if e = json.Unmarshal(captured, &hashes); e != nil {
		t.Fatal(e)
	}
	var expected []struct {
		Accepted       bool
		Policy         Object
		DefinitionHash string
	}
	if e = json.Unmarshal(output, &expected); e != nil {
		t.Fatal(e)
	}
	for i, input := range inputs {
		policy, e := ParsePolicy(input)
		if (e == nil) != expected[i].Accepted {
			t.Errorf("original policy acceptance differs at %d", i)
		}
		if e == nil {
			actual, _ := json.Marshal(policy)
			wanted, _ := json.Marshal(expected[i].Policy)
			if string(actual) != string(wanted) {
				t.Errorf("original policy normalization differs at %d", i)
			}
			hash, e := DefinitionHash(input)
			if e != nil || hash != hashes[i].DefinitionHash {
				t.Errorf("original definition hash differs at %d: %v", i, e)
			}
		}
	}
}
