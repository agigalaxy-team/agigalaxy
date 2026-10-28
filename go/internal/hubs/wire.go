package hubs

import "github.com/agigalaxy-team/agigalaxy/go/internal/protocol"

func ordered(pairs ...any) *protocol.OrderedObject {
	out := protocol.NewOrderedObject()
	for i := 0; i+1 < len(pairs); i += 2 {
		out.Set(pairs[i].(string), pairs[i+1])
	}
	return out
}
func schemaOrder(schema any, value any) any {
	s := obj(schema)
	if o := obj(value); o != nil {
		s = pick(s, o)
		if properties, ok := s["properties"].(*protocol.OrderedObject); ok {
			out := protocol.NewOrderedObject()
			for _, key := range properties.Keys() {
				if v, ok := o[key]; ok {
					out.Set(key, schemaOrder(properties.Values()[key], v))
				}
			}
			return out
		}
	}
	if values, ok := value.([]any); ok {
		out := []any{}
		for i, v := range values {
			item := s["items"]
			if prefix := arr(s["prefixItems"]); i < len(prefix) {
				item = prefix[i]
			}
			out = append(out, schemaOrder(item, v))
		}
		return out
	}
	return value
}
func parsedWire(name string, raw []byte) (*protocol.OrderedObject, error) {
	v, e := parse(name, raw)
	if e != nil {
		return nil, e
	}
	// Validation above uses the common schema; the exact wire projection keeps
	// JavaScript strings rather than replacing isolated UTF-16 code units.
	precise, e := wireDecode(raw)
	if e != nil {
		return nil, e
	}
	v = obj(precise)
	contracts, e := protocol.DecodeOrdered([]byte(peeringContractsJSON))
	if e != nil {
		return nil, e
	}
	schema := obj(contracts)[name]
	if schema == nil {
		contracts, e = protocol.DecodeOrdered([]byte(contractsJSON))
		if e != nil {
			return nil, e
		}
		schema = obj(contracts)[name]
	}
	v = obj(normalize(obj(schema), precise))
	out, _ := schemaOrder(schema, v).(*protocol.OrderedObject)
	return out, nil
}
