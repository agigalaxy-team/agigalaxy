package summaries

import (
	"bytes"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestOriginalSummarySchemaAndIntent(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	version := "22222222-2222-4222-8222-222222222222"
	base := Object{"versionId": version, "summaryId": id, "roomId": id, "baseRevision": 0, "preferenceRevision": 0, "content": Object{"generator": Object{"kind": "manual"}, "coverage": Object{"fromSequence": "0000", "throughSequence": "90071992547409930000", "complete": false}, "fragments": []any{Object{"id": id, "kind": "derived", "text": "explicit", "sourceRefs": []any{Object{"messageId": id, "revision": 1}}}}, "keyMessageRefs": []any{}}}
	type input struct {
		Action string `json:"action"`
		Raw    string `json:"raw"`
	}
	inputs := []input{}
	appendInput := func(action string, v any) {
		b, _ := jstext.EncodeJSON(v)
		inputs = append(inputs, input{action, string(b)})
	}
	appendInput("put", base)
	raw, _ := json.Marshal(base)
	for _, count := range []int{8000, 8001} {
		v, _ := jstext.DecodeJSON(raw)
		object(array(object(object(v)["content"])["fragments"])[0])["text"] = strings.Repeat("😀", count)
		appendInput("put", v)
	}
	v, _ := jstext.DecodeJSON(raw)
	object(array(object(object(v)["content"])["fragments"])[0])["text"], _ = jstext.ParseJSON([]byte(`"\ud800 exact"`))
	appendInput("put", v)
	v, _ = jstext.DecodeJSON(raw)
	object(v)["baseRevision"] = float64(9007199254740992)
	appendInput("put", v)
	v, _ = jstext.DecodeJSON(raw)
	object(array(object(object(v)["content"])["fragments"])[0])["sourceRefs"] = []any{}
	appendInput("put", v)
	appendInput("preferences/save", Object{"expectedRevision": 0, "endpoint": "https://example.invalid", "enabled": true})
	appendInput("preferences/save", Object{"expectedRevision": 0, "endpoint": "bad url", "enabled": true})
	appendInput("list", Object{})
	appendInput("list", Object{"after": nil})
	appendInput("receipt", Object{"summaryId": id, "versionId": version, "extra": false})
	root, _ := filepath.Abs("../../..")
	script := `import {canonicalInformationCommand as canonicalize} from './packages/galaxy-contracts/src/information-canonical.mjs';import {digest} from './packages/galaxy-contracts/src/digest.mjs';import * as schemas from './packages/galaxy-contracts/src/personal-summary-schema.mjs';const names={'preferences/save':'summaryPreferenceSchema',put:'summaryPutSchema',list:'summaryPageSchema',receipt:'summaryReceiptSchema'};let text='';for await(const c of process.stdin)text+=c;console.log(JSON.stringify(JSON.parse(text).map(x=>{let parsed;try{parsed=schemas[names[x.action]].parse(JSON.parse(x.raw))}catch{return{accepted:false}}const r={accepted:true,json:JSON.stringify(parsed)};if(x.action==='put'){const{preferenceRevision,...intent}=parsed;try{r.hash=digest(canonicalize(intent))}catch{r.hashError=true}}return r})))`
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
			t.Fatalf("schema %d Go=%v original=%v", i, e, expected[i].Accepted)
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
			intent := Object{}
			for k, v := range parsed {
				if k != "preferenceRevision" {
					intent[k] = v
				}
			}
			hash, e := digestIntent(intent)
			if (e != nil) != expected[i].HashError || e == nil && hash != expected[i].Hash {
				t.Fatalf("intent %d %s %s %v", i, hash, expected[i].Hash, e)
			}
		}
	}
}
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
