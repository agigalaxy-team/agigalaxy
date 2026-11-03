package native

import "github.com/agigalaxy-team/agigalaxy/go/internal/mcpschema"

func projectModelToolSchema(schema map[string]any) { mcpschema.ProjectModel(schema) }
func forEachToolSubschema(schema map[string]any, visit func(map[string]any)) {
	mcpschema.ForEachSubschema(schema, visit)
}
