package operationsqueries

import (
	_ "embed"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/maintenance"
	"github.com/google/jsonschema-go/jsonschema"
	"strings"
	"sync"
)

func trim(s string) string {
	return strings.Trim(s, "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
}

//go:embed query-contract.json
var queryContract []byte
var contractOnce sync.Once
var contractError error
var toolSchemas map[string]*jsonschema.Resolved
var filterSchemas map[string]*jsonschema.Resolved

func loadContract() {
	var wire struct {
		Query, Read json.RawMessage
		Filters     map[string]json.RawMessage
	}
	if e := json.Unmarshal(queryContract, &wire); e != nil {
		contractError = e
		return
	}
	toolSchemas, filterSchemas = map[string]*jsonschema.Resolved{}, map[string]*jsonschema.Resolved{}
	resolve := func(raw json.RawMessage) (*jsonschema.Resolved, error) {
		var schema jsonschema.Schema
		if e := json.Unmarshal(raw, &schema); e != nil {
			return nil, e
		}
		return schema.Resolve(nil)
	}
	for name, raw := range map[string]json.RawMessage{"query-operations": wire.Query, "read-operation-object": wire.Read} {
		schema, e := resolve(raw)
		if e != nil {
			contractError = e
			return
		}
		toolSchemas[name] = schema
	}
	for key, raw := range wire.Filters {
		schema, e := resolve(raw)
		if e != nil {
			contractError = e
			return
		}
		filterSchemas[key] = schema
	}
}

// The embedded shapes are generated from the same original Zod tool schemas.
// Apply nested defaults only when filters was explicitly supplied: the outer
// Zod default({}) does not evaluate the nested schema on an omitted property.
func normalizeQueryArguments(tool string, input Object) (Object, error) {
	contractOnce.Do(loadContract)
	if contractError != nil {
		return nil, fail("operations_query_response_invalid", 503)
	}
	raw, e := json.Marshal(input)
	if e != nil {
		return nil, invalid()
	}
	var wire Object
	if json.Unmarshal(raw, &wire) != nil {
		return nil, invalid()
	}
	if filters, present := wire["filters"]; present {
		q := object(filters)
		if value, ok := q["query"].(string); ok {
			q["query"] = trim(value)
		}
		if tool == "query-operations" && wire["module"] == "maintenance" && wire["view"] != "overview" {
			parsed, e := maintenance.ParseQuery(str(wire["view"]), q)
			if e != nil {
				return nil, invalid()
			}
			wire["filters"] = parsed
		}
	}
	schema := toolSchemas[tool]
	if schema == nil || schema.Validate(wire) != nil {
		return nil, invalid()
	}
	out := merge(wire)
	if filters, present := wire["filters"]; present {
		key := str(wire["module"]) + ":" + str(wire["view"])
		if tool == "read-operation-object" {
			key = "read:" + str(wire["kind"])
		}
		if schema := filterSchemas[key]; schema != nil {
			var value any = merge(object(filters))
			if e := schema.ApplyDefaults(&value); e != nil {
				return nil, invalid()
			}
			out["filters"] = value
		}
		if q, ok := object(out["filters"])["query"].(string); ok {
			object(out["filters"])["query"] = trim(q)
		}
	}
	return out, nil
}
