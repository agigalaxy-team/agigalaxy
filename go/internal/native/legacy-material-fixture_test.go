package native

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"testing"
	"time"
)

var syntheticMaterialUUID = regexp.MustCompile(`^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`)

// Generated IDs and wall-clock times vary between test runs. Preserve all
// repeated ID relationships and compare every other field to the JS reader's
// captured projection of the original synthetic SQLite records.
func normalizeLegacyMaterial(t *testing.T, input any) any {
	t.Helper()
	raw, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	var value any
	if err = json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	ids := map[string]string{}
	var visit func(any) any
	visit = func(value any) any {
		switch x := value.(type) {
		case map[string]any:
			keys := make([]string, 0, len(x))
			for key := range x {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			for _, key := range keys {
				x[key] = visit(x[key])
			}
			return x
		case []any:
			for i := range x {
				x[i] = visit(x[i])
			}
			return x
		case string:
			if syntheticMaterialUUID.MatchString(x) {
				if _, ok := ids[x]; !ok {
					ids[x] = fmt.Sprintf("<id-%d>", len(ids)+1)
				}
				return ids[x]
			}
			if _, err := time.Parse(time.RFC3339Nano, x); err == nil {
				return "<timestamp>"
			}
		}
		return value
	}
	return visit(value)
}
