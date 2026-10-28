package agentos

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
)

// AutonomyRequest shares the loaded transport/keys, but signs the separate
// original duty-task scope. It conveys no management Cookie or human AI proof.
func (c *Client) AutonomyRequest(ctx context.Context, taskID, planID, accountID string, delegationVersion *int64, suffix string, write bool) (Object, error) {
	if c == nil || !c.Configured() || c.configuration.ServiceKey == "" {
		return nil, fail("operations_agentos_not_configured", 503)
	}
	if !validOperationID(taskID) || !validOperationID(planID) || !validOperationID(accountID) || write && (suffix != "/runs" && suffix != "/cancel" && suffix != "/continue") || !write && suffix != "" {
		return nil, fail("invalid_operations_autonomy_request", 400)
	}
	at := c.now().Unix()
	claims := struct {
		Sub               string `json:"sub"`
		Iss               string `json:"iss"`
		Aud               string `json:"aud"`
		Iat               int64  `json:"iat"`
		Exp               int64  `json:"exp"`
		JTI               string `json:"jti"`
		Scope             string `json:"scope"`
		TaskID            string `json:"taskId"`
		PlanID            string `json:"planId"`
		AccountID         string `json:"accountId"`
		DelegationVersion *int64 `json:"delegationVersion"`
	}{"autonomy:" + taskID, "galaxy-operations", "galaxy-agentos", at, at + 60, uuid.NewString(), "task", taskID, planID, accountID, delegationVersion}
	token, err := c.signToken(claims)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	method := http.MethodGet
	var body io.Reader
	if write {
		method = http.MethodPost
		body = strings.NewReader("{}")
	}
	request, err := http.NewRequestWithContext(ctx, method, c.configuration.URL+"/galaxy/autonomy/tasks/"+taskID+suffix, body)
	if err != nil {
		return nil, fail("operations_autonomy_result_unknown", 503)
	}
	request.GetBody = nil
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-Galaxy-Service-Key", c.configuration.ServiceKey)
	if write {
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Idempotency-Key", taskID)
	}
	response, err := c.http.Do(request)
	if err != nil {
		return nil, fail("operations_autonomy_result_unknown", 503)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 3*1024*1024+1))
	if err != nil {
		return nil, fail("operations_autonomy_response_invalid", 503)
	}
	raw = bytes.TrimPrefix(raw, []byte{0xef, 0xbb, 0xbf})
	if len(raw) > 3*1024*1024 || protocol.TextLength(string(raw)) > 1024*1024 {
		return nil, fail("operations_autonomy_response_invalid", 503)
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return nil, fail("operations_autonomy_response_invalid", 503)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.StatusCode == 403 {
			return nil, fail("operations_autonomy_authority_changed", 403)
		}
		return nil, fail("operations_autonomy_native_unavailable", 503)
	}
	result, ok := value.(map[string]any)
	if !ok {
		return nil, fail("operations_autonomy_response_invalid", 503)
	}
	return result, nil
}
