// Package operationsquerycontract exposes the generated, closed query contract
// to both query execution and the autonomous completion ledger.
package operationsquerycontract

import (
	_ "embed"
	"encoding/json"
	"sort"
	"strings"
	"sync"

	"github.com/google/jsonschema-go/jsonschema"
)

//go:embed query-contract.json
var source []byte

func Source() []byte { return append([]byte(nil), source...) }

func ToolSchema(tool string) *jsonschema.Resolved {
	once.Do(initContract)
	return toolSchemas[tool]
}

func FilterSchema(key string) *jsonschema.Resolved {
	once.Do(initContract)
	return filterSchemas[key]
}

type Object = map[string]any

var once sync.Once
var schemaCache sync.Map
var moduleViews map[string][]string
var allowedModules, allowedKinds []string
var toolSchemas, filterSchemas map[string]*jsonschema.Resolved
var propertySchemas map[string]map[string]*jsonschema.Resolved
var contract struct {
	Query, Read Object
	Filters     map[string]Object
}

func initContract() {
	if err := json.Unmarshal(source, &contract); err != nil {
		panic(err)
	}
	moduleViews = map[string][]string{}
	toolSchemas = map[string]*jsonschema.Resolved{"query-operations": resolve(contract.Query), "read-operation-object": resolve(contract.Read)}
	filterSchemas = map[string]*jsonschema.Resolved{}
	propertySchemas = map[string]map[string]*jsonschema.Resolved{}
	for key, definition := range contract.Filters {
		filterSchemas[key] = resolve(definition)
		propertySchemas[key] = map[string]*jsonschema.Resolved{}
		for name, property := range obj(definition["properties"]) {
			propertySchemas[key][name] = resolve(property)
		}
	}
	for name := range contract.Filters {
		p := strings.SplitN(name, ":", 2)
		if len(p) != 2 {
			continue
		}
		if p[0] == "read" {
			allowedKinds = append(allowedKinds, p[1])
		} else {
			moduleViews[p[0]] = append(moduleViews[p[0]], p[1])
		}
	}
	for module, views := range moduleViews {
		sort.Strings(views)
		moduleViews[module] = views
		allowedModules = append(allowedModules, module)
	}
	sort.Strings(allowedModules)
	sort.Strings(allowedKinds)
}
func obj(v any) Object  { o, _ := v.(map[string]any); return o }
func text(v any) string { s, _ := v.(string); return s }
func list(v any) []any  { a, _ := v.([]any); return a }
func resolve(value any) *jsonschema.Resolved {
	b, e := json.Marshal(value)
	if e != nil {
		return nil
	}
	if cached, ok := schemaCache.Load(string(b)); ok {
		return cached.(*jsonschema.Resolved)
	}
	var s jsonschema.Schema
	if json.Unmarshal(b, &s) != nil {
		return nil
	}
	r, e := s.Resolve(nil)
	if e != nil {
		return nil
	}
	actual, _ := schemaCache.LoadOrStore(string(b), r)
	return actual.(*jsonschema.Resolved)
}
func valid(schema any, value any) bool {
	r := resolve(schema)
	return r != nil && r.Validate(value) == nil
}
func stringsOf(value any) []string {
	out := []string{}
	for _, v := range list(value) {
		if s := text(v); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// QueryCoverageScope returns only schema-owned field names and valid values.
// Invalid values and unknown field names are never echoed. Pagination controls
// are excluded from scope; defaults are projected from the same source schema.
func QueryCoverageScope(tool string, input Object) Object {
	once.Do(initContract)
	out := Object{"valid": false, "tool": tool, "module": nil, "view": nil, "kind": nil, "id": nil, "filters": Object{}, "invalidFilterKeys": []any{}, "missingRequired": []any{}, "unknownFields": false, "unknownFilterFields": false, "unknownTopLevel": false, "invalidRoute": false}
	var key string
	if tool == "query-operations" {
		module, view := text(input["module"]), text(input["view"])
		views := moduleViews[module]
		if len(views) == 0 {
			out["allowedModules"] = append([]string{}, allowedModules...)
			out["invalidRoute"] = true
			return out
		}
		out["module"], out["allowedViews"] = module, append([]string{}, views...)
		key = module + ":" + view
		if contract.Filters[key] == nil {
			out["invalidRoute"] = true
			return out
		}
		out["view"] = view
	} else if tool == "read-operation-object" {
		kind := text(input["kind"])
		key = "read:" + kind
		if contract.Filters[key] == nil {
			out["allowedKinds"] = append([]string{}, allowedKinds...)
			out["invalidRoute"] = true
			return out
		}
		out["kind"] = kind
		var route Object
		for _, v := range list(contract.Read["oneOf"]) {
			item := obj(v)
			if obj(obj(item["properties"])["kind"])["const"] == kind {
				route = item
				break
			}
		}
		id := input["id"]
		idFormat := "opaque"
		if route != nil && obj(obj(route["properties"])["id"])["format"] == "uuid" {
			idFormat = "uuid"
		}
		out["idFormat"] = idFormat
		if route == nil || !valid(obj(obj(route["properties"])["id"]), id) {
			out["invalidRoute"] = true
		} else {
			if idFormat == "uuid" {
				id = strings.ToLower(text(id))
			}
			out["id"] = id
		}
	} else {
		out["invalidRoute"] = true
		return out
	}
	definition := contract.Filters[key]
	props := obj(definition["properties"])
	keys := make([]string, 0, len(props))
	for k := range props {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out["allowedFilterKeys"], out["requiredFilterKeys"] = keys, stringsOf(definition["required"])
	filters := obj(input["filters"])
	if _, present := input["filters"]; present && filters == nil {
		out["invalidFilters"] = true
		filters = Object{}
	}
	if filters == nil {
		filters = Object{}
	}
	missing := []any{}
	for _, k := range stringsOf(definition["required"]) {
		if _, ok := filters[k]; !ok {
			missing = append(missing, k)
		}
	}
	out["missingRequired"] = missing
	normalized := Object{}
	for k, v := range filters {
		normalized[k] = v
	}
	if value, ok := normalized["query"].(string); ok {
		normalized["query"] = strings.Trim(value, "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
	}
	if r := filterSchemas[key]; r != nil {
		var value any = normalized
		_ = r.ApplyDefaults(&value)
		if x := obj(value); x != nil {
			normalized = x
		}
	}
	invalid := []any{}
	enums, ranges, formats := Object{}, Object{}, Object{}
	for _, k := range keys {
		property := obj(props[k])
		variants := list(property["anyOf"])
		if len(variants) == 0 {
			variants = list(property["oneOf"])
		}
		if len(variants) == 0 {
			variants = []any{property}
		}
		values := []any{}
		for _, v := range variants {
			branch := obj(v)
			if enum := list(branch["enum"]); len(enum) > 0 {
				values = append(values, enum...)
			}
			if c, ok := branch["const"]; ok {
				values = append(values, c)
			}
			if branch["type"] == "number" || branch["type"] == "integer" {
				r := Object{"integer": branch["type"] == "integer"}
				for _, n := range []string{"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"} {
					if x, ok := branch[n]; ok {
						r[n] = x
					}
				}
				ranges[k] = r
			}
			if f := text(branch["format"]); f == "uuid" || f == "date-time" {
				formats[k] = f
			}
		}
		if len(values) > 0 {
			enums[k] = values
		}
		v, present := normalized[k]
		if !present {
			continue
		}
		if schema := propertySchemas[key][k]; schema == nil || schema.Validate(v) != nil {
			invalid = append(invalid, k)
			continue
		}
		if formats[k] == "uuid" {
			v = strings.ToLower(text(v))
		}
		if k != "after" && k != "limit" && k != "page" && k != "pageSize" {
			obj(out["filters"])[k] = v
		}
	}
	unknownFilters, unknownTop := false, false
	for k := range filters {
		if _, ok := props[k]; !ok {
			unknownFilters = true
		}
	}
	for k := range input {
		if tool == "query-operations" && k != "module" && k != "view" && k != "filters" || tool == "read-operation-object" && k != "kind" && k != "id" && k != "filters" {
			unknownTop = true
		}
	}
	unknown := unknownFilters || unknownTop
	out["unknownFields"], out["unknownFilterFields"], out["unknownTopLevel"], out["invalidFilterKeys"], out["filterEnums"], out["filterNumberRanges"], out["filterFormats"] = unknown, unknownFilters, unknownTop, invalid, enums, ranges, formats
	out["valid"] = !unknown && len(missing) == 0 && len(invalid) == 0 && out["invalidRoute"] == false && out["invalidFilters"] != true
	return out
}
