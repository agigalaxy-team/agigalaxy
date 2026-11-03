package operationsautonomy

// querySourceProof stores only source locators and versions returned by the
// current query service. It never stores source bodies or presentation labels.
func querySourceProof(result Object) Object {
	proof := Object{"sourceProofVersion": 1, "complete": false, "material": "present", "refs": []any{}}
	raw, present := result["evidenceRefs"]
	refs, ok := raw.([]any)
	if !present || !ok {
		return proof
	}
	if result["data"] == nil && len(refs) == 0 {
		proof["complete"], proof["material"] = true, "none"
		return proof
	}
	if len(refs) == 0 {
		return proof
	}
	selected := make([]any, 0, len(refs))
	sourceIDs := map[string]bool{}
	collection := result["evidenceScope"] == "collection"
	for _, value := range refs {
		source := obj(value)
		read := obj(source["read"])
		if source == nil || str(source["kind"]) == "" || str(source["id"]) == "" ||
			!has([]string{"query-operations", "read-operation-object"}, str(read["tool"])) || obj(read["arguments"]) == nil {
			return proof
		}
		controlled, valid := source["controlledSource"].(bool)
		if !valid || controlled && source["version"] == nil {
			return proof
		}
		if collection && controlled {
			return proof
		}
		ref := Object{}
		for _, key := range []string{"kind", "id", "version", "controlledSource", "purpose", "read"} {
			if value, exists := source[key]; exists {
				ref[key] = clone(value)
			}
		}
		selected = append(selected, ref)
		if source["kind"] != "operations-query" {
			sourceIDs[str(source["id"])] = true
		}
	}
	if str(result["tool"]) == "read-operation-object" {
		read := obj(obj(refs[0])["read"])
		if !sourceIDs[str(obj(read["arguments"])["id"])] {
			return proof
		}
	}
	// Business objects retain individual references. Authorized operational
	// collections (for example logs) are read as a collection, including partial
	// pages; source coverage remains separate from access to returned material.
	if items, exists := obj(result["data"])["items"]; exists && !collection {
		rows, ok := items.([]any)
		if !ok {
			return proof
		}
		for _, value := range rows {
			row := obj(value)
			id := ""
			for _, key := range []string{"id", "accountId", "reportId", "runId", "registrationId"} {
				if id = str(row[key]); id != "" {
					break
				}
			}
			if id == "" || !sourceIDs[id] {
				return proof
			}
		}
	}
	proof["refs"], proof["complete"] = selected, true
	return proof
}
