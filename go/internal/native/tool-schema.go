package native

// This is an additive description for SDKs that only inspect object properties.
// Original union branches remain present and remain the server's validator.
func projectToolObjectFields(schema map[string]any) {
	for _, value := range schema {
		switch child := value.(type) {
		case map[string]any:
			projectToolObjectFields(child)
		case []any:
			for _, item := range child {
				if object, ok := item.(map[string]any); ok {
					projectToolObjectFields(object)
				}
			}
		}
	}
	if schema["type"] != "object" || schema["properties"] != nil {
		return
	}
	branches, _ := schema["oneOf"].([]any)
	if len(branches) == 0 {
		branches, _ = schema["anyOf"].([]any)
	}
	if len(branches) == 0 {
		return
	}
	fields := map[string][]any{}
	var required []any
	for index, branch := range branches {
		object, _ := branch.(map[string]any)
		properties, ok := object["properties"].(map[string]any)
		if object["type"] != "object" || !ok {
			return
		}
		for name, field := range properties {
			fields[name] = append(fields[name], field)
		}
		current, _ := object["required"].([]any)
		if index == 0 {
			required = append([]any{}, current...)
		} else {
			common := []any{}
			for _, name := range required {
				for _, candidate := range current {
					if name == candidate {
						common = append(common, name)
						break
					}
				}
			}
			required = common
		}
	}
	properties := map[string]any{}
	for name, alternatives := range fields {
		unique := []any{}
		for _, field := range alternatives {
			duplicate := false
			for _, prior := range unique {
				if connectionEqual(prior, field) {
					duplicate = true
					break
				}
			}
			if !duplicate {
				unique = append(unique, field)
			}
		}
		if len(unique) == 1 {
			properties[name] = unique[0]
			continue
		}
		// String discriminators commonly mix const and enum in different branches.
		values := []any{}
		allStrings := true
		for _, field := range unique {
			object, _ := field.(map[string]any)
			enum, _ := object["enum"].([]any)
			if constant, ok := object["const"].(string); ok {
				enum = []any{constant}
			}
			if len(enum) == 0 {
				allStrings = false
				break
			}
			for _, value := range enum {
				if _, ok := value.(string); !ok {
					allStrings = false
					break
				}
				found := false
				for _, prior := range values {
					found = found || prior == value
				}
				if !found {
					values = append(values, value)
				}
			}
		}
		if allStrings {
			properties[name] = map[string]any{"type": "string", "enum": values}
		} else {
			properties[name] = map[string]any{"anyOf": unique}
		}
	}
	schema["properties"], schema["required"] = properties, required
}
