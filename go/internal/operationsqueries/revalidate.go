package operationsqueries

import (
	"context"
	"encoding/json"
	"slices"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
)

// Revalidate repeats the original fixed current read. A saved descriptor,
// timestamp or version never substitutes for the source's current authority.
func (s *Service) Revalidate(ctx context.Context, actor Actor, domain string, evidenceRefs []Object) (Object, error) {
	if evidenceRefs == nil || len(evidenceRefs) > 300 {
		return nil, invalid()
	}
	refs, invalidRefs := []any{}, []any{}
	memo := map[string]Object{}
	for _, original := range evidenceRefs {
		read := object(original["read"])
		tool := str(read["tool"])
		id := Object{"kind": original["kind"], "id": original["id"]}
		if !slices.Contains([]string{"query-operations", "read-operation-object"}, tool) {
			invalidRefs = append(invalidRefs, id)
			continue
		}
		raw, e := json.Marshal(read)
		if e != nil {
			return nil, e
		}
		key := string(raw)
		result := memo[key]
		if result == nil {
			result, e = s.Query(ctx, actor, domain, tool, object(read["arguments"]))
			if e != nil {
				if slices.Contains([]int{403, 404, 409, 410}, fault.Status(e)) {
					invalidRefs = append(invalidRefs, id)
					continue
				}
				return nil, e
			}
			memo[key] = result
		}
		var current Object
		for _, value := range result["evidenceRefs"].([]any) {
			ref := object(value)
			if ref["kind"] == original["kind"] && ref["id"] == original["id"] {
				current = ref
				break
			}
		}
		if current == nil {
			invalidRefs = append(invalidRefs, id)
			continue
		}
		if original["controlledSource"] == true {
			before, e := identity.Canonical([]any{original["version"]})
			if e != nil {
				return nil, e
			}
			after, e := identity.Canonical([]any{current["version"]})
			if e != nil {
				return nil, e
			}
			if current["controlledSource"] != true || string(before) != string(after) {
				invalidRefs = append(invalidRefs, id)
				continue
			}
		}
		refs = append(refs, current)
	}
	return Object{"valid": len(invalidRefs) == 0, "refs": refs, "invalidRefs": invalidRefs}, nil
}
