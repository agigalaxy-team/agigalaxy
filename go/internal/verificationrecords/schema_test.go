package verificationrecords

import (
	"testing"
)

func TestOriginalRecordSchemaNormalizationAndStrictFields(t *testing.T) {
	var fixture struct {
		Vectors []any `json:"vectors"`
		Values  []any `json:"values"`
	}
	fixtureJSON(t, "schema", &fixture)
	vectors, expected := fixture.Vectors, fixture.Values
	for i, v := range vectors {
		got, e := parseRecord(string(encode(v)))
		want := obj(expected[i])
		if (e == nil) != (want["accepted"] == true) {
			t.Fatalf("schema %d Go=%v JS=%v input=%s", i, e, want, encode(v))
		}
		if e == nil {
			same(t, got, want["value"])
		}
	}
}
