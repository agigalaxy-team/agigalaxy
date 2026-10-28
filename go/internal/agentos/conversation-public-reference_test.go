package agentos

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

func TestConversationPublicReferenceOriginalContract(t *testing.T) {
	id, version, other := "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"
	cases := []Object{
		{"reference": Object{"kind": "post", "id": id}, "args": Object{"kind": "post", "id": id}, "current": Object{}},
		{"reference": Object{"kind": "post", "id": id, "versionId": version}, "args": Object{"kind": "post", "id": id}, "current": Object{"versionId": version}},
		{"reference": Object{"kind": "post", "id": id, "versionId": version}, "args": Object{"kind": "post", "id": id}, "current": Object{"versionId": other}},
		{"reference": Object{"kind": "reply", "id": id}, "args": Object{"kind": "post", "id": id}, "current": Object{}},
		{"reference": Object{"kind": "reply", "id": id, "versionId": version}, "args": Object{"kind": "reply", "id": id}, "current": Object{}},
		{"reference": Object{"kind": "post", "id": id, "url": "https://example.invalid"}, "args": Object{}, "current": Object{}},
		{"reference": nil, "args": Object{}, "current": Object{}},
	}
	raw, _ := json.Marshal(cases)
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	cmd := exec.Command("node", "--input-type=module", "-e", `import{readFileSync}from'node:fs';import{createHash}from'node:crypto';import canonicalize from'./packages/galaxy-official/node_modules/canonicalize/lib/canonicalize.js';import{conversationPublicReferenceSchema as schema,checkConversationPublicReference as check}from'./packages/galaxy-official/src/operations/agentos/public-reference.mjs';console.log(JSON.stringify(JSON.parse(readFileSync(0,'utf8')).map(x=>{const parsed=schema.safeParse(x.reference);if(!parsed.success)return{parsed:false};let code='';try{check(parsed.data,x.args.kind,x.args.id,x.current)}catch(e){code=e.code}return{parsed:true,code,digest:createHash('sha256').update(canonicalize({arguments:x.args,publicReference:parsed.data})).digest('hex')}})));`)
	cmd.Dir, cmd.Stdin = root, bytes.NewReader(raw)
	output, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	var original []struct {
		Parsed       bool
		Code, Digest string
	}
	if err = json.Unmarshal(output, &original); err != nil {
		t.Fatal(err)
	}
	for i, input := range cases {
		ref, err := parseConversationPublicReference(input["reference"])
		if (err == nil) != original[i].Parsed {
			t.Fatalf("case %d schema differs", i)
		}
		if err != nil {
			continue
		}
		err = checkConversationPublicReference(ref, object(input["args"]), object(input["current"]))
		code := ""
		if err != nil {
			code = fault.Code(err)
		}
		digest, digestErr := conversationArgumentsDigest(object(input["args"]), ref)
		if digestErr != nil || code != original[i].Code || digest != original[i].Digest {
			t.Fatalf("case %d check/digest differs", i)
		}
	}
}
