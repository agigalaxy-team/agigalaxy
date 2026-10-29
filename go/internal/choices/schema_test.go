package choices

import (
	"bytes"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestOriginalChoiceSchemasAndIntent(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	version := "22222222-2222-4222-8222-222222222222"
	hash := strings.Repeat("a", 64)
	ref := Object{"type": "task", "id": id, "version": hash}
	base := Object{"snapshotId": id, "versionId": version, "baseRevision": 0, "preferenceRevision": 1, "content": Object{"localVersion": 1, "localTaskRef": " local ", "visibleRationale": " explicit ", "rationaleAuthor": "user", "candidateRefs": []any{ref}, "selectedRefs": []any{ref}, "resultRefs": []any{}}, "witnesses": []any{Object{"search": Object{"type": "task", "query": Object{"view": "requested"}}, "ref": Object{"id": id, "version": hash}}}}
	type input struct {
		Action string `json:"action"`
		Raw    string `json:"raw"`
	}
	inputs := []input{}
	appendInput := func(action string, v any) { b, _ := json.Marshal(v); inputs = append(inputs, input{action, string(b)}) }
	appendInput("put", base)
	unsafe := objectMust(mustJSON(base))
	unsafe["baseRevision"] = float64(9007199254740992)
	appendInput("put", unsafe)
	raw, _ := json.Marshal(base)
	for _, rationale := range []string{strings.Repeat("😀", 1200), strings.Repeat("😀", 1201), `\ud800 retained`, strings.Repeat("x", 1199) + `\ud800`} {
		decoded, _ := jstext.DecodeJSON(raw)
		v := object(decoded)
		body := object(v["content"])
		if strings.Contains(rationale, `\ud800`) {
			body["visibleRationale"], _ = jstext.ParseJSON([]byte(`"` + rationale + `"`))
		} else {
			body["visibleRationale"] = rationale
		}
		b, _ := jstext.EncodeJSON(v)
		inputs = append(inputs, input{"put", string(b)})
	}
	appendInput("preferences/save", Object{"endpoint": "https://example.invalid", "expectedRevision": 0, "enabled": true, "snapshotIds": []any{id}})
	appendInput("preferences/save", Object{"endpoint": "not a url", "expectedRevision": 0, "enabled": true, "snapshotIds": []any{id}})
	appendInput("preferences/save", Object{"endpoint": "https://example.invalid", "expectedRevision": 0, "enabled": true, "snapshotIds": []any{id, id}})
	appendInput("preferences/save", Object{"endpoint": "javascript:alert(1)", "expectedRevision": 0, "enabled": false, "snapshotIds": []any{}})
	appendInput("list", Object{})
	appendInput("list", Object{"limit": 0})
	appendInput("get", Object{"snapshotId": id, "extra": false})
	appendInput("receipt", Object{"snapshotId": id, "versionId": version, "requestHash": hash})
	appendInput("delete", Object{"snapshotId": id, "expectedRevision": -1})
	duplicate := objectMust(raw)
	object(duplicate["content"])["candidateRefs"] = []any{ref, ref}
	appendInput("put", duplicate)
	root, _ := filepath.Abs("../../..")
	script := `import {canonicalInformationCommand as canonicalize} from './packages/galaxy-contracts/src/information-canonical.mjs'; import {digest} from './packages/galaxy-contracts/src/digest.mjs'; import {choicePutIntent} from './packages/galaxy-contracts/src/choice-snapshot-schema-v2.mjs'; import * as schemas from './packages/galaxy-contracts/src/choice-snapshot-schema-v2.mjs'; const names={'preferences/save':'choicePreferenceSchema',get:'choiceGetSchema',list:'choicePageSchema',delete:'choiceDeleteSchema',receipt:'choiceReceiptQuerySchema',put:'choicePutSchema'};let text='';for await(const c of process.stdin)text+=c;console.log(JSON.stringify(JSON.parse(text).map(x=>{let value;try{value=schemas[names[x.action]].parse(JSON.parse(x.raw))}catch{return {accepted:false}}const r={accepted:true,json:JSON.stringify(value)};if(x.action==='put'){try{r.hash=digest(canonicalize(choicePutIntent(value)))}catch{r.hashError=true}}return r})))`
	cmd := exec.Command("node", "--input-type=module", "-e", script)
	cmd.Dir = root
	rawInputs, _ := json.Marshal(inputs)
	cmd.Stdin = bytes.NewReader(rawInputs)
	b, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("current contract schema %v %s", e, b)
	}
	var expected []struct {
		Accepted   bool
		JSON, Hash string
		HashError  bool
	}
	if e = json.Unmarshal(b, &expected); e != nil {
		t.Fatal(e)
	}
	for i, in := range inputs {
		value, e := jstext.DecodeJSON([]byte(in.Raw))
		var parsed Object
		if e == nil {
			parsed, e = Parse(in.Action, object(value))
		}
		if (e == nil) != expected[i].Accepted {
			t.Fatalf("schema %d Go=%v original=%v input=%s", i, e, expected[i].Accepted, in.Raw)
		}
		if e != nil {
			continue
		}
		original, e := jstext.DecodeJSON([]byte(expected[i].JSON))
		if e != nil {
			t.Fatal(e)
		}
		a, _ := json.Marshal(plain(parsed))
		b, _ := json.Marshal(plain(original))
		if string(a) != string(b) {
			t.Fatalf("parsed %d Go=%s original=%s", i, a, b)
		}
		if in.Action == "put" {
			hash, e := digestIntent(PutIntent(parsed))
			if (e != nil) != expected[i].HashError || e == nil && hash != expected[i].Hash {
				t.Fatalf("intent %d %s %s %v", i, hash, expected[i].Hash, e)
			}
		}
	}
}
func objectMust(raw []byte) Object { v, _ := jstext.DecodeJSON(raw); return object(v) }
func mustJSON(v any) []byte        { b, _ := json.Marshal(v); return b }
func plain(v any) any {
	if o := object(v); o != nil {
		out := Object{}
		for k, v := range o {
			out[k] = plain(v)
		}
		return out
	}
	if a, ok := v.([]any); ok {
		out := []any{}
		for _, v := range a {
			out = append(out, plain(v))
		}
		return out
	}
	return v
}
