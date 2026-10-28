package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"strings"
)

type NativeProjects struct{ runtime *Runtime }

func NewNativeProjects(runtime *Runtime) *NativeProjects { return &NativeProjects{runtime} }
func (c *NativeProjects) Call(ctx context.Context, name string, input any, expected *ChoiceScope) (map[string]any, error) {
	if name == "galaxy_project_v2_preferences_save" && expected == nil {
		return nil, fault.New("native_choice_binding_required", 409)
	}
	return remoteBusinessCall(ctx, c.runtime, name, input, expected, remoteProjectRequest)
}
func remoteProjectRequest(name string, value map[string]any) (string, any, string, error) {
	method := "POST"
	body := any(value)
	path := ""
	switch name {
	case "galaxy_project_v2_query":
		path = "/v2/projects/query"
	case "galaxy_project_v2_get":
		path = "/v2/projects/" + text(value["projectId"])
		method = "GET"
		body = nil
	case "galaxy_project_v2_event":
		path = "/v2/projects"
	case "galaxy_project_v2_preferences", "galaxy_project_v2_preferences_save":
		id := text(value["projectId"])
		delete(value, "projectId")
		action := "read"
		if name == "galaxy_project_v2_preferences_save" {
			action = "save"
		}
		path = "/v2/projects/" + id + "/preferences/" + action
	default:
		return "", nil, "", remoteFactsInvalid()
	}
	return path, body, method, nil
}
func registerRemoteProjectTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	registerRemoteBusinessTools(server, tools, runtime, func(name string) bool { return strings.HasPrefix(name, "galaxy_project_v2_") }, remoteProjectRequest)
}
