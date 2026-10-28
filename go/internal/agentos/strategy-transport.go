package agentos

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const strategyWorkflow = "galaxy-p13-selected-content-v1"

// StrategyStatus retains the original second workflow health observation.
// A connected conversation engine alone does not prove this workflow exists.
func (c *Client) StrategyStatus(ctx context.Context) (Object, error) {
	status := c.Status(ctx)
	status["workflow"] = strategyWorkflow
	if status["state"] != "connected" {
		return status, nil
	}
	check, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(check, http.MethodGet, c.configuration.URL+"/health", nil)
	if err != nil {
		status["state"] = "not-connected"
		return status, nil
	}
	response, err := c.http.Do(request)
	if err != nil {
		status["state"] = "not-connected"
		return status, nil
	}
	defer response.Body.Close()
	value, err := decodeResponse(response)
	workflow := object(object(value)["strategies"])
	version, valid := index(workflow["workflowVersion"])
	if err != nil || response.StatusCode < 200 || response.StatusCode >= 300 || workflow["state"] != "ready" || workflow["workflowId"] != strategyWorkflow || !valid || version != 1 {
		status["state"] = "not-connected"
	}
	return status, nil
}

// StrategyRequest uses the existing execution JWT and shared transport. These
// paths never accept a model URL or turn a missing receipt into send permission.
func (c *Client) StrategyRequest(ctx context.Context, executionID, runID, suffix string, form url.Values, operationID string) (Object, error) {
	invalid := func() (Object, error) { return nil, fail("invalid_p13_native_request", 400) }
	if !validOperationID(executionID) || !validOperationID(runID) {
		return invalid()
	}
	key := ""
	switch {
	case suffix == "":
		if form != nil || operationID != "" {
			return invalid()
		}
	case suffix == "/start":
		if len(form) != 1 || len(form["session_id"]) != 1 || !validOperationID(form.Get("session_id")) || operationID != "" && operationID != runID {
			return invalid()
		}
		key = runID
	case suffix == "/continue":
		if len(form) != 2 || len(form["session_id"]) != 1 || !validOperationID(form.Get("session_id")) || !validOperationID(operationID) {
			return invalid()
		}
		confirmed, decision := form["confirmed"], form["input_decision"]
		if len(confirmed) == 1 && len(decision) == 0 {
			if confirmed[0] != "true" && confirmed[0] != "false" {
				return invalid()
			}
		} else if len(decision) != 1 || len(confirmed) != 0 {
			return invalid()
		}
		key = operationID
	case strings.HasPrefix(suffix, "/continuations/"):
		id := strings.TrimPrefix(suffix, "/continuations/")
		if !validOperationID(id) || form != nil || operationID != "" {
			return invalid()
		}
	default:
		return invalid()
	}
	result, err := c.request(ctx, Execution{ID: executionID}, "/galaxy/p13-strategies/"+runID+suffix, form, key)
	if err != nil {
		return nil, err
	}
	value := object(result)
	if value == nil {
		return nil, fail("p13_native_response_invalid", 503)
	}
	return value, nil
}
