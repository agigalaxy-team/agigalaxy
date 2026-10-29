package taskmaterials

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func equalJSON(t *testing.T, a, b any, label string) {
	t.Helper()
	if canonical(a) != canonical(b) {
		t.Fatalf("%s differs from original JSON", label)
	}
}

func TestOriginalCommentUnicodeAndURLFingerprints(t *testing.T) {
	inputs := []string{`" Ａ\u200bB \t HTTP://ExAmPle.COM:80/a/../b?x=1#fragment "`, `"http://127.1/a http://0x7f.1 http://faß.de/%7e?q='x' HTTP://例子.测试:80/a\\b#x"`, `"ΟΣ @İＤ @用户 @guid0000000000000000000000000000"`, `"\ud800x\udfff https://example.com/\ud800?q=\udfff"`, `"https://example.com/Ａ#frag\ufeff https://example.com/a.%2e/.."`}
	out, e := os.ReadFile("testdata/comment-fingerprints-original.json")
	if e != nil {
		t.Fatal(e)
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
	inputs = append(inputs, strings.Replace(base, `"body":" \ud800😀 "`, `"body":"\ud800`+strings.Repeat("😀", 5999)+`"`, 1), strings.Replace(base, `"body":" \ud800😀 "`, `"body":"\ud800`+strings.Repeat("😀", 6000)+`"`, 1))
	out, e := os.ReadFile("testdata/comment-schema-original.json")
	if e != nil {
		t.Fatal(e)
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
