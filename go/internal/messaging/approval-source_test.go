package messaging

import (
	"encoding/json"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestOriginalPersistedApprovalSourceStrictMatch(t *testing.T) {
	input := Object{"aiAccountId": "fixture-ai", "operation": Object{"targetId": "fixture-plan", "permission": "notices.publish", "operationId": "fixture-operation"}, "grantVersion": 3, "selection": Object{"transient": true}, "continuation": true, "businessAction": "notices.publish"}
	stored := obj(clone(input))
	delete(stored, "selection")
	delete(stored, "continuation")
	delete(stored, "businessAction")
	stored["messagePlanId"] = "fixture-plan"
	stored["messageVersion"] = 2
	plan := Object{"id": "fixture-plan", "state": "active", "version": 2, "approved_by": "ai:fixture-ai", "approved_role": nil, "approved_ai": stored, "config": Object{"automation": Object{"kind": "ordinary", "factsConfirmed": true}}}
	type vector struct {
		Plan, Input Object
		Allowed     bool
	}
	vectors := []vector{{Plan: plan, Input: input}}
	for _, field := range []string{"state", "version", "approved_by", "approved_role", "approved_ai", "config"} {
		copy := obj(clone(plan))
		switch field {
		case "state":
			copy[field] = "paused"
		case "version":
			copy[field] = 3
		case "approved_by":
			copy[field] = "other"
		case "approved_role":
			copy[field] = "reader"
		case "approved_ai":
			copy[field] = nil
		case "config":
			copy[field] = Object{"automation": Object{"kind": "ordinary", "factsConfirmed": false}}
		}
		vectors = append(vectors, vector{Plan: copy, Input: input})
	}
	for _, field := range []string{"grantVersion", "operation", "aiAccountId", "extra"} {
		copy := obj(clone(input))
		copy[field] = "changed"
		vectors = append(vectors, vector{Plan: plan, Input: copy})
	}
	raw, _ := json.Marshal(vectors)
	root, _ := filepath.Abs("../../..")
	script := `import{MessagingBase}from './packages/galaxy-official/src/operations/messaging/base.mjs';let v=JSON.parse(process.argv[1]);for(let x of v){const s=new MessagingBase({});s.planWithin=async()=>x.Plan;s.autonomy={validatePersistedOperationWithin:async()=>({allowed:true})};x.Allowed=(await s.validatePersistedApprovalWithin({},x.Input)).allowed}console.log(JSON.stringify(v))`
	cmd := exec.Command("node", "--input-type=module", "-e", script, string(raw))
	cmd.Dir = root
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original %v %s", e, out)
	}
	var original []vector
	if e = json.Unmarshal(out, &original); e != nil {
		t.Fatal(e)
	}
	for i, v := range original {
		if got := persistedApprovalSource(v.Plan, v.Input); got != v.Allowed {
			t.Errorf("source %d Go %v JS %v", i, got, v.Allowed)
		}
	}
	if !persistedApprovalSource(plan, input) {
		t.Fatal("matching source denied")
	}
}
