package agentos

import (
	"encoding/json"
	"github.com/google/uuid"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestExecutionInputsMatchOriginalZodIncludingCodepointBounds(t *testing.T) {
	root, _ := filepath.Abs("../../..")
	target := uuid.NewString()
	makeInput := func(reason string) Object {
		return Object{"operationId": uuid.NewString(), "grantId": uuid.NewString(), "expectedGrantVersion": 1, "domain": "governance", "actions": []string{"content.read", "content.hide"}, "resourceIds": []string{target}, "preparedCommand": Object{"tool": "content-visibility", "targetKind": "post", "targetId": target, "input": Object{"expectedVersion": 1, "expectedRevision": 0, "kind": "hide", "until": 2000000600, "reason": reason}}}
	}
	inputs := []Object{makeInput("\ufeff original reason \ufeff"), makeInput(strings.Repeat("🚀", 1600)), makeInput(strings.Repeat("🚀", 1601)), makeInput("\u0085ab"), makeInput("\ufeffab\ufeff")}
	duplicate := makeInput("valid reason")
	duplicate["resourceIds"] = []string{target, target}
	inputs = append(inputs, duplicate)
	missing := makeInput("valid reason")
	delete(missing, "preparedCommand")
	inputs = append(inputs, missing)
	restore := makeInput("valid reason")
	object(object(restore["preparedCommand"])["input"])["kind"] = "restore"
	inputs = append(inputs, restore)
	unknown := makeInput("valid reason")
	unknown["privateProof"] = "not-authority"
	inputs = append(inputs, unknown)
	source := `import {agentOsCreateSchema} from './packages/galaxy-contracts/src/operations-agentos-schema.mjs';let raw='';for await(const b of process.stdin)raw+=b;console.log(JSON.stringify(JSON.parse(raw).map(x=>{const p=agentOsCreateSchema.safeParse(x);return p.success?{success:true,data:p.data}:{success:false}})));`
	cmd := exec.Command("node", "--input-type=module", "-e", source)
	cmd.Dir = root
	body, _ := json.Marshal(inputs)
	cmd.Stdin = strings.NewReader(string(body))
	raw, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original input %v %s", e, raw)
	}
	var expected []Object
	if json.Unmarshal(raw, &expected) != nil {
		t.Fatal("invalid oracle")
	}
	for i, input := range inputs {
		got, e := parseExecutionCreate(input)
		if (e == nil) != (expected[i]["success"] == true) {
			t.Fatalf("input %d acceptance differed %v", i, e)
		}
		if e == nil {
			body, _ := json.Marshal(got)
			var normalized Object
			json.Unmarshal(body, &normalized)
			if !reflect.DeepEqual(normalized, object(expected[i]["data"])) {
				t.Fatalf("input %d normalization differed", i)
			}
		}
	}
}
