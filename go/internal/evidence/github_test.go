package evidence

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"path/filepath"
	"testing"
)

func TestOriginalGithubSourceObservationAndExactResponseHash(t *testing.T) {
	reference := Object{"provider": "github-actions", "owner": "Fixture", "repository": "Synthetic", "runId": 11, "attempt": 1, "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
	raw := `{"id":11.0,"run_attempt":1,"head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":"completed","conclusion":"success","repository":{"full_name":"fixture/synthetic","private":false,"id":77,"owner":{"id":3,"login":"Fixture","type":"Organization"}},"updated_at":"2033-05-18T03:33:20.000Z","note":"\u2028 literal \\u2028","numbers":[-0,1e21,333333333.33333329],"10":true,"2":false}`
	run, e := protocol.DecodeOrdered([]byte(raw))
	if e != nil {
		t.Fatal(e)
	}
	vectors := []any{Object{"reference": reference, "run": run}}
	for _, change := range []Object{{"id": 11.5}, {"status": "unsupported"}, {"repository": Object{"full_name": "fixture/synthetic", "private": true, "id": 77}}, {"run_attempt": 2}, {"updated_at": "2033-05-18T03:38:21Z"}} {
		parsed, _ := protocol.DecodeOrdered([]byte(raw))
		o := parsed.(*protocol.OrderedObject)
		for k, v := range change {
			o.Set(k, v)
		}
		vectors = append(vectors, Object{"reference": reference, "run": o})
	}
	expected := arr(node(t, "postgres://unused@127.0.0.1/galaxy_go_test_source", "source", filepath.Join(t.TempDir(), "evidence-fixture.json"), vectors)["values"])
	for i, v := range vectors {
		x := obj(v)
		got, e := InspectGithubRun(reference, x["run"], 2000000000)
		want := obj(expected[i])
		if e != nil {
			if want["rejected"] != true {
				t.Fatalf("source %d rejected %v", i, e)
			}
			continue
		}
		if want["rejected"] == true {
			t.Fatalf("source %d accepted mismatched response", i)
		}
		same(t, got, want["value"])
		if _, e = checked(GithubSource{}, got, reference, 2000000000); e != nil {
			t.Fatal(e)
		}
	}
}
