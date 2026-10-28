package operationscommunity

import (
	"bytes"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/google/uuid"
	"os/exec"
	"strings"
	"testing"
)

func TestOriginalBusinessSchemasAstralAndPresence(t *testing.T) {
	id := uuid.NewString()
	cases := []Object{}
	add := func(kind string, x Object) { cases = append(cases, Object{"kind": kind, "input": x}) }
	for _, kind := range []string{"page", "sections", "reports"} {
		add(kind, Object{})
		add(kind, Object{"after": nil})
		add(kind, Object{"limit": 100})
		add(kind, Object{"limit": 101})
		add(kind, Object{"after": id, "unknown": true})
		for _, v := range []string{"00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff", strings.ReplaceAll(id, "-", "")} {
			add(kind, Object{"after": v})
		}
	}
	for _, count := range []int{2, 3, 1600, 1601} {
		add("classify", Object{"operationId": id, "expectedVersion": 0, "category": "life", "reason": "\ufeff " + strings.Repeat("🚀", count) + " \ufeff"})
	}
	for _, kind := range []string{"hide", "restore"} {
		for _, until := range []any{nil, 2000000100} {
			x := Object{"operationId": id, "kind": kind, "expectedVersion": 1, "expectedVisibilityVersion": 0, "reason": "原因说明"}
			if until != nil {
				x["until"] = until
			}
			add("visibility", x)
		}
	}
	for _, action := range []string{"keep", "hide", "release"} {
		for _, until := range []any{nil, 2000000100} {
			x := Object{"operationId": id, "expectedVersion": 1, "resolution": "accepted", "summary": "原说明", "restrictionAction": action}
			if until != nil {
				x["hideUntil"] = until
			}
			add("resolve", x)
		}
	}
	cmd := exec.Command("node", "testdata/schema.mjs")
	cmd.Stdin = bytes.NewReader(encode(cases))
	raw, e := cmd.Output()
	if e != nil {
		t.Fatal(e)
	}
	var expected []Object
	if e = json.Unmarshal(raw, &expected); e != nil {
		t.Fatal(e)
	}
	for i, c := range cases {
		kind := str(c, "kind")
		var got Object
		var err error
		if has([]string{"page", "sections", "reports"}, kind) {
			got, err = parsePage(obj(c, "input"), kind)
		} else {
			got, err = parseWrite(obj(c, "input"), kind)
		}
		if (err == nil) != yes(expected[i], "accepted") {
			t.Fatalf("case%d %v accepted%v original%v", i, c, err == nil, expected[i])
		}
		if err == nil {
			x, _ := identity.Canonical(got)
			y, _ := identity.Canonical(expected[i]["value"])
			if !bytes.Equal(x, y) {
				t.Fatalf("case%d normalized%s !=%s", i, x, y)
			}
		}
	}
}
