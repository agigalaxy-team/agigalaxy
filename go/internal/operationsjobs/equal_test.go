package operationsjobs

import "testing"

func TestEqualCanonicalValues(t *testing.T) {
	if !equal(int64(4), float64(4)) {
		t.Fatal("equal retry counts must compare equal")
	}
	if equal(int64(4), float64(5)) {
		t.Fatal("different retry counts compared equal")
	}
	if !equal(map[string]any{"count": int64(4)}, map[string]any{"count": float64(4)}) {
		t.Fatal("equivalent structured selections must compare equal")
	}
	if equal(map[string]any{"count": 4}, map[string]any{"count": 5}) {
		t.Fatal("different selections compared equal")
	}
}
