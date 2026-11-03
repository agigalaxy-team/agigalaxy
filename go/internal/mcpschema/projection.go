// Package mcpschema projects an independent JSON Schema copy for tool advertisements.
// Callers retain and validate the unmodified original schema.
package mcpschema

import (
	"encoding/json"
	"reflect"
)

// Project applies the existing object and model compatibility projections in order.
func Project(schema map[string]any) { ProjectObjectFields(schema); ProjectModel(schema) }

// jsonEqual retains the JSON-normalized equality semantics of the original projection.
func jsonEqual(a, b any) bool {
	normalize := func(v any) any { raw, _ := json.Marshal(v); var out any; _ = json.Unmarshal(raw, &out); return out }
	return reflect.DeepEqual(normalize(a), normalize(b))
}
