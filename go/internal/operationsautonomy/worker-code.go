package operationsautonomy

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

// RunWorkerCodeTask preserves the original restricted worker dispatch. The
// existing Native transport binds the stored task/plan/account/delegation to a
// task-scope proof. AgentOS's code branch calls the private API without creating
// a model run; that API owns the current duty authority and domain actions.
// The worker never needs an operator session or the API's write consumers.
func (s *Service) RunWorkerCodeTask(ctx context.Context, taskID string) (Object, error) {
	if s == nil || s.Pool == nil || s.Native == nil {
		return nil, fault.New("operations_agentos_not_configured", 503)
	}
	if !schemaUUID.MatchString(taskID) {
		return nil, invalid()
	}
	row, err := s.readTask(ctx, taskID)
	if err != nil {
		return nil, err
	}
	if row["mode"] != "code" {
		return nil, fault.New("operations_autonomy_scope_denied", 403)
	}
	// Worker.Execute has committed the only dispatch before invoking this hook.
	// Errors keep its existing unknown state; recovery uses Native.Read and the
	// same original task rather than issuing another POST or operation number.
	result, err := s.Native.Run(ctx, row)
	if err != nil {
		return nil, err
	}
	// The original AgentOS code response carries the API's status projection,
	// not its state field. Interpret that existing receipt for Worker.Execute;
	// this does not infer an effect from a model result or mutate task state.
	if str(result["state"]) == "" {
		out := Object{}
		for key, value := range result {
			out[key] = value
		}
		state := "unknown"
		switch result["status"] {
		case "COMPLETED":
			state = "completed"
		case "PAUSED":
			state = "waiting-human"
		case "ERROR":
			state = "failed"
		case "CANCELLED":
			state = "stopped"
		}
		out["state"] = state
		result = out
	}
	return result, nil
}
