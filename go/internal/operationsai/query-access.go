package operationsai

import "encoding/json"

// QueryAccess describes the original generated permission mapping only. It
// neither reads business data nor establishes handler/source readiness.
func QueryAccess(permissions []string) Object {
	var modules map[string][]struct {
		View       string `json:"view"`
		Permission string `json:"permission"`
	}
	json.Unmarshal([]byte(queryJSON), &modules)
	allowed := Object{}
	for module, entries := range modules {
		views := []string{}
		for _, entry := range entries {
			if contains(permissions, entry.Permission) {
				views = append(views, entry.View)
			}
		}
		if len(views) > 0 {
			allowed[module] = views
		}
	}
	return Object{"basis": "current-human-ai-query-permission-intersection", "dataRead": false, "allowedViews": allowed}
}
