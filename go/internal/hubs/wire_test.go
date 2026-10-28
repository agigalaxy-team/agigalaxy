package hubs

import (
	"bytes"
	"os/exec"
	"testing"
)

func TestPeerFingerprintOriginalJSONStringifyCodeUnitsAndOrder(t *testing.T) {
	raw := []byte(`{"a":[-0,1e-7,1e21,"\ud800&\u2028"],"z":{"x":"\udfff","a":"😀"},"again":1,"again":2}`)
	command := exec.Command("node", "--input-type=module", "-e", `let input='';for await(const part of process.stdin)input+=part;process.stdout.write(JSON.stringify(JSON.parse(input)));`)
	command.Stdin = bytes.NewReader(raw)
	want, e := command.Output()
	if e != nil {
		t.Fatal(e)
	}
	value, e := wireDecode(raw)
	if e != nil {
		t.Fatal(e)
	}
	got, e := wireEncode(value)
	if e != nil || !bytes.Equal(got, want) {
		t.Fatalf("wire differs: Go=%s JS=%s error=%v", got, want, e)
	}
}
