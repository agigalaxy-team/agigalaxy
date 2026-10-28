package history

import (
	"bytes"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"os/exec"
	"testing"
)

func TestOrderedJSONMatchesOriginalStringify(t *testing.T) {
	vectors := []string{
		`{"z":1.0,"10":"ten","2":"two","01":0,"4294967295":3,"a":-0,"nested":{"q":1e21,"p":1e-7,"x":333333333.33333329}}`,
		`{"dup":0,"last":1,"dup":2,"strings":["<>&","\u2028\u2029","\\u2028","\\\\u2029","a\nb\t\u0000"],"array":[null,true,false,9007199254740993]}`,
		`{"large":1e400,"negative":-1e400,"tiny":1e-400}`,
	}
	for _, raw := range vectors {
		parsed, e := protocol.DecodeOrdered([]byte(raw))
		if e != nil {
			t.Fatal(e)
		}
		got, e := protocol.EncodeJS(parsed)
		if e != nil {
			t.Fatal(e)
		}
		cmd := exec.Command("node", "--input-type=module", "-e", `let text='';for await(const c of process.stdin)text+=c;process.stdout.write(JSON.stringify(JSON.parse(text)));`)
		cmd.Stdin = bytes.NewBufferString(raw)
		want, e := cmd.Output()
		if e != nil {
			t.Fatal(e)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("Go %s\nJS %s", got, want)
		}
	}
}
