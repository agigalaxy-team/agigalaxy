package operationsqueries

import "testing"

func TestStrategyVersionReadIsClosedAndRouted(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	a, err := parse("read-operation-object", Object{"kind": "strategy-version", "id": id})
	if err != nil || a.kind != "strategy-version" || a.module != "strategies" || a.id != id {
		t.Fatalf("strategy-version route: %#v %v", a, err)
	}
	if _, err = parse("read-operation-object", Object{"kind": "strategy-version", "id": id, "filters": Object{"extra": true}}); err == nil {
		t.Fatal("unexpected filter accepted")
	}
}

func TestSearchVersionReadIsClosedAndRouted(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	a, err := parse("read-operation-object", Object{"kind": "search-version", "id": id})
	if err != nil || a.kind != "search-version" || a.module != "search" || a.id != id {
		t.Fatalf("search-version route: %#v %v", a, err)
	}
	if _, err = parse("read-operation-object", Object{"kind": "search-version", "id": id, "filters": Object{"extra": true}}); err == nil {
		t.Fatal("unexpected filter accepted")
	}
}
