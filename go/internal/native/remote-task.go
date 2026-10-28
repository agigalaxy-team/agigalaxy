package native

import (
	"context"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"strings"
)

type NativeTasks struct{ runtime *Runtime }

func NewNativeTasks(runtime *Runtime) *NativeTasks { return &NativeTasks{runtime} }
func (c *NativeTasks) Call(ctx context.Context, name string, input any) (map[string]any, error) {
	return remoteBusinessCall(ctx, c.runtime, name, input, nil, remoteTaskRequest)
}
func remoteTaskSelected(name string) bool {
	return strings.HasPrefix(name, "galaxy_task_v2_") || isOne(name, "galaxy_tasks_v2_query", "galaxy_task_material_prepare", "galaxy_task_material_status", "galaxy_participation_v2_propose", "galaxy_participation_v2_event")
}
func remoteTaskRequest(name string, value map[string]any) (string, any, string, error) {
	path := ""
	method := "POST"
	body := any(value)
	switch name {
	case "galaxy_tasks_v2_query":
		path = "/v2/tasks/query"
	case "galaxy_task_v2_get":
		path = "/v2/tasks/" + text(value["taskId"])
		method = "GET"
		body = nil
	case "galaxy_task_material_prepare":
		path = "/v2/task-materials/prepare"
	case "galaxy_task_material_status":
		path = "/v2/tasks/" + text(value["taskId"]) + "/materials/status"
		method = "GET"
		body = nil
	case "galaxy_task_v2_create":
		path = "/v2/tasks"
	case "galaxy_task_v2_receipt":
		path = "/v2/tasks/receipt"
	case "galaxy_participation_v2_event":
		id := text(value["participationId"])
		delete(value, "participationId")
		path = "/v2/participations/" + id + "/events"
	default:
		actions := map[string]string{"galaxy_task_v2_event": "events", "galaxy_participation_v2_propose": "participations", "galaxy_task_v2_owner_read_prepare": "owner-read/prepare", "galaxy_task_v2_owner_read": "owner-read", "galaxy_task_v2_owner_control_prepare": "owner-control/prepare", "galaxy_task_v2_owner_control": "owner-control"}
		action := actions[name]
		if action == "" {
			return "", nil, "", remoteFactsInvalid()
		}
		id := text(value["taskId"])
		delete(value, "taskId")
		path = "/v2/tasks/" + id + "/" + action
	}
	return path, body, method, nil
}
func registerRemoteTaskTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	registerRemoteBusinessTools(server, tools, runtime, remoteTaskSelected, remoteTaskRequest)
}
