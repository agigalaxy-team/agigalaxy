package localdata

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

func TestRedactionMatchesOriginalJavaScript(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	source := filepath.ToSlash(filepath.Join(filepath.Dir(file), "../../../packages/galaxy-core/src/local-data-redaction.mjs"))
	script := `import {redactLocalWorkData} from 'file:///` + source + `';let raw='';for await(const chunk of process.stdin)raw+=chunk;process.stdout.write(JSON.stringify(JSON.parse(raw).map(redactLocalWorkData)));`
	inputs := []json.RawMessage{
		json.RawMessage(`{"source":{"kind":"host-event"},"password":"invented-test-value","nested":{"api_key":null,"safe":"ok"},"quoted":"password: \"sample value\"; token?key=example&x=1"}`),
		json.RawMessage(`{"text":"Bearer aaaaaaaaaaaa == Basic YWFhYWFhYWE= sk-abcdefghijklmnop URL https://test:invented@example.invalid/path --token=test-value ?token=test-value&x=1","密码":"safe field; not a canonical credential field","data":"data:image/png;base64,AA=="}`),
		json.RawMessage(`{"jwk":{"kty":"RSA","d":"fake"},"text":"-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY----- password=[excluded credential] --token=[excluded credential] ?key=[excluded credential]","非ASCII字段":{"client secret":"x"}}`),
		json.RawMessage(`{"text":"password = fake \n--password　value https://a:b@example.invalid ?access_token=sample","authorization":"[excluded credential]","parts":[null,7,false,{"env":{"X":"fake"}}]}`),
		json.RawMessage(`{"10":"ten","2":"two","a":1.0,"b":1e-7,"c":1e20,"d":1e21,"separator":"a\u2028b\u2029c","literal":"\\u2028","kty":0,"k":"ordinary material"}`),
	}
	raw, _ := json.Marshal(inputs)
	cmd := exec.Command("node", "--input-type=module", "-e", script)
	cmd.Stdin = bytes.NewReader(raw)
	want, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original JS redaction: %v %s", e, want)
	}
	got := []Result{}
	for _, input := range inputs {
		r, e := RedactJSON(input)
		if e != nil {
			t.Fatal(e)
		}
		got = append(got, r)
	}
	encoded, e := Encode(got)
	if e != nil {
		t.Fatal(e)
	}
	var a, b any
	json.Unmarshal(want, &a)
	json.Unmarshal(encoded, &b)
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("redaction differs\nJS %s\nGo %s", want, encoded)
	}
	if !bytes.Equal(want, encoded) {
		t.Fatalf("JSON storage bytes differ\nJS %s\nGo %s", want, encoded)
	}
}
