package cases

import (
	"testing"
)

func TestOriginalFactSchemasAndTaskOperationHashes(t *testing.T) {
	var fixture struct {
		Input  Object `json:"input"`
		Result Object `json:"result"`
	}
	fixtureJSON(t, "pure", &fixture)
	schemas, link, oracle := list(fixture.Input["schemas"]), object(fixture.Input["link"]), fixture.Result
	expected := list(oracle["schemas"])
	for i, p := range schemas {
		got, e := parseFact(string(encode(p)))
		want := object(expected[i])
		if (e == nil) != (want["accepted"] == true) {
			t.Fatalf("schema %d Go=%v JS=%v input=%s", i, e, want, encode(p))
		}
		if e == nil {
			same(t, got, want["value"])
		}
	}
	current, legacy, e := linkHashes(link)
	if e != nil {
		t.Fatal(e)
	}
	same(t, Object{"current": current, "legacy": legacy}, oracle["hashes"])
}
