package taskmaterials

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestOriginalCommentUnicodeAndURLFingerprints(t *testing.T) {
	inputs := []string{`" Ａ\u200bB \t HTTP://ExAmPle.COM:80/a/../b?x=1#fragment "`, `"http://127.1/a http://0x7f.1 http://faß.de/%7e?q='x' HTTP://例子.测试:80/a\\b#x"`, `"ΟΣ @İＤ @用户 @guid0000000000000000000000000000"`, `"\ud800x\udfff https://example.com/\ud800?q=\udfff"`, `"https://example.com/Ａ#frag\ufeff https://example.com/a.%2e/.."`}
	root, _ := filepath.Abs("../../..")
	file := filepath.Join(t.TempDir(), "fingerprints.json")
	raw, _ := json.Marshal(inputs)
	_ = os.WriteFile(file, raw, 0600)
	cmd := exec.Command("node", filepath.Join(root, "scripts/go/task-materials-interop.mjs"), "fingerprints", file)
	cmd.Dir = root
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original fingerprints: %v %s", e, out)
	}
	var expected []Object
	if e = json.Unmarshal(out, &expected); e != nil {
		t.Fatal(e)
	}
	c := &CommentService{}
	for i, input := range inputs {
		body, e := parseJSText([]byte(input))
		if e != nil {
			t.Fatal(e)
		}
		actual, e := c.fingerprints(body)
		if e != nil {
			t.Fatal(e)
		}
		equalJSON(t, actual, expected[i], "original Unicode/WHATWG fingerprints")
		if i == 3 && !bytes.Contains(jsonBytes(body), []byte(`\ud800`)) {
			t.Fatal("retained JavaScript text changed lone surrogate")
		}
	}
}
func TestOriginalCommentSchema(t *testing.T) {
	base := `{"schemaVersion":2,"id":"11111111-1111-4111-8111-111111111111","commentId":"22222222-2222-4222-8222-222222222222","taskId":"33333333-3333-4333-8333-333333333333","expectedRevision":0,"kind":"create","body":" \ud800😀 ","visibility":"inherit-task"}`
	inputs := []string{base, strings.Replace(base, `"expectedRevision":0`, `"expectedRevision":0.0`, 1), strings.Replace(base, `"expectedRevision":0,`, "", 1), strings.Replace(base, `"visibility":"inherit-task"`, `"visibility":"inherit-task","replyTo":null`, 1), strings.Replace(base, `"body":" \ud800😀 "`, `"body":" "`, 1), strings.Replace(base, `"visibility":"inherit-task"`, `"visibility":"Public"`, 1)}
	cases := []Object{}
	inputs = append(inputs, strings.Replace(base, `"body":" \ud800😀 "`, `"body":"\ud800`+strings.Repeat("😀", 5999)+`"`, 1), strings.Replace(base, `"body":" \ud800😀 "`, `"body":"\ud800`+strings.Repeat("😀", 6000)+`"`, 1))
	for _, input := range inputs {
		cases = append(cases, Object{"kind": "comment", "json": input})
	}
	root, _ := filepath.Abs("../../..")
	file := filepath.Join(t.TempDir(), "comments.json")
	raw, _ := json.Marshal(cases)
	_ = os.WriteFile(file, raw, 0600)
	cmd := exec.Command("node", filepath.Join(root, "scripts/go/task-materials-interop.mjs"), "schemas", file)
	cmd.Dir = root
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original comment schema: %v %s", e, out)
	}
	var expected []struct {
		Accepted bool
		Value    json.RawMessage
	}
	if e = json.Unmarshal(out, &expected); e != nil {
		t.Fatal(e)
	}
	for i, input := range inputs {
		actual, e := parseComment(Envelope{PayloadJSON: input})
		if (e == nil) != expected[i].Accepted {
			t.Errorf("comment acceptance differs at %d", i)
		}
		if e == nil {
			original, _ := parseObject(string(expected[i].Value))
			body, e := rawCommentBody(string(expected[i].Value))
			if e != nil {
				t.Fatal(e)
			}
			original["body"] = body
			equalJSON(t, actual, original, "comment schema normalized projection")
			if !bytes.Contains(jsonBytes(actual), []byte(`\ud800`)) {
				t.Fatal("comment accepted body changed lone surrogate")
			}
		}
	}
}
