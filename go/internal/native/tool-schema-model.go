package native

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
)

// Visit only JSON Schema positions. Values in default, examples, const, enum
// and other instance-valued annotations are data, not nested schemas.
func forEachToolSubschema(schema map[string]any, visit func(map[string]any)) {
	for _, key := range []string{"properties", "patternProperties", "$defs", "definitions", "dependentSchemas"} {
		fields, _ := schema[key].(map[string]any)
		for _, value := range fields {
			if child, ok := value.(map[string]any); ok {
				visit(child)
			}
		}
	}
	for _, key := range []string{"items", "additionalItems", "contains", "additionalProperties", "unevaluatedProperties", "propertyNames"} {
		switch child := schema[key].(type) {
		case map[string]any:
			visit(child)
		case []any: // Older tuple-form items.
			for _, value := range child {
				if item, ok := value.(map[string]any); ok {
					visit(item)
				}
			}
		}
	}
	for _, key := range []string{"oneOf", "anyOf", "allOf", "prefixItems"} {
		items, _ := schema[key].([]any)
		for _, value := range items {
			if child, ok := value.(map[string]any); ok {
				visit(child)
			}
		}
	}
}

func copyToolSchemaValue(value any) any {
	switch current := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(current))
		for key, item := range current {
			out[key] = copyToolSchemaValue(item)
		}
		return out
	case []any:
		out := make([]any, len(current))
		for index, item := range current {
			out[index] = copyToolSchemaValue(item)
		}
		return out
	default:
		return value
	}
}

func modelSchemaNumber(value any) (float64, bool) {
	switch number := value.(type) {
	case float64:
		return number, !math.IsNaN(number) && !math.IsInf(number, 0)
	case json.Number:
		parsed, err := strconv.ParseFloat(string(number), 64)
		return parsed, err == nil && !math.IsNaN(parsed) && !math.IsInf(parsed, 0)
	default:
		return 0, false
	}
}

func modelSchemaDescription(schema map[string]any, addition string) {
	current, _ := schema["description"].(string)
	if strings.TrimSpace(current) == "" {
		schema["description"] = addition
	} else {
		schema["description"] = strings.TrimSpace(current) + " " + addition
	}
}

func modelSchemaValues(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(encoded)
}

func modelSchemaNumberType(schema map[string]any, allIntegers bool) {
	if _, present := schema["type"]; present {
		return
	}
	if allIntegers {
		schema["type"] = "integer"
	} else {
		schema["type"] = "number"
	}
}

// projectModelToolSchema changes only the advertised description. The raw
// handler has already resolved the original schema and validates original JSON
// values independently. This pass never coerces tool arguments.
func projectModelToolSchema(schema map[string]any) {
	forEachToolSubschema(schema, projectModelToolSchema)
	// Weakening an exclusion would instead reject originally valid values.
	// If it needs projection, omit that exclusion from the advertisement.
	if original, ok := schema["not"].(map[string]any); ok {
		projected := copyToolSchemaValue(original).(map[string]any)
		projectModelToolSchema(projected)
		if !connectionEqual(original, projected) {
			delete(schema, "not")
			modelSchemaDescription(schema, "Additional exclusions are validated by the server.")
		}
	}
	// oneOf branches may overlap after a non-string constraint is described
	// instead of encoded. anyOf cannot reject an originally valid branch.
	if branches, ok := schema["oneOf"].([]any); ok {
		delete(schema, "oneOf")
		if _, exists := schema["anyOf"]; !exists {
			schema["anyOf"] = branches
		} else {
			all, _ := schema["allOf"].([]any)
			schema["allOf"] = append(all, map[string]any{"anyOf": branches})
		}
	}
	if value, exists := schema["const"]; exists {
		if _, stringValue := value.(string); !stringValue {
			delete(schema, "const")
			if number, ok := modelSchemaNumber(value); ok {
				modelSchemaNumberType(schema, math.Trunc(number) == number)
				schema["minimum"], schema["maximum"] = value, value
			} else {
				if _, ok := value.(bool); ok {
					if _, present := schema["type"]; !present {
						schema["type"] = "boolean"
					}
				}
				modelSchemaDescription(schema, "Must equal "+modelSchemaValues(value)+".")
			}
		}
	}
	values, exists := schema["enum"].([]any)
	if !exists || len(values) == 0 {
		return
	}
	allStrings, allNumbers, allIntegers, allBooleans := true, true, true, true
	var minimum, maximum float64
	for index, value := range values {
		if _, ok := value.(string); !ok {
			allStrings = false
		}
		if _, ok := value.(bool); !ok {
			allBooleans = false
		}
		number, ok := modelSchemaNumber(value)
		if !ok {
			allNumbers, allIntegers = false, false
			continue
		}
		if math.Trunc(number) != number {
			allIntegers = false
		}
		if index == 0 || number < minimum {
			minimum = number
		}
		if index == 0 || number > maximum {
			maximum = number
		}
	}
	if allStrings {
		return
	}
	delete(schema, "enum")
	if allBooleans {
		if _, present := schema["type"]; !present {
			schema["type"] = "boolean"
		}
	}
	if allNumbers {
		modelSchemaNumberType(schema, allIntegers)
		_, hasAny := schema["anyOf"]
		_, hasOne := schema["oneOf"]
		if !hasAny && !hasOne {
			branches := make([]any, 0, len(values))
			for _, value := range values {
				kind := "number"
				if number, ok := modelSchemaNumber(value); ok && math.Trunc(number) == number {
					kind = "integer"
				}
				branches = append(branches, map[string]any{"type": kind, "minimum": value, "maximum": value})
			}
			schema["anyOf"] = branches
			return
		}
		schema["minimum"], schema["maximum"] = minimum, maximum
	}
	modelSchemaDescription(schema, "Allowed values: "+modelSchemaValues(values)+".")
}
