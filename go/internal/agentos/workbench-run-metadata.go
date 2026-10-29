package agentos

import "context"

// WorkbenchRunMetadata reads only the native run's closed metadata. It never
// returns provider output, conversation text, events or spans.
func (c *Client) WorkbenchRunMetadata(ctx context.Context, id string) (Object, error) {
	if !overviewID.MatchString(id) {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	raw, err := c.RunDetail(ctx, id)
	if err != nil {
		return nil, err
	}
	run, err := overviewRun(object(object(raw)["run"]))
	if err != nil || run["runId"] != id {
		return nil, fail("operations_agentos_response_invalid", 503)
	}
	return Object{"run": run}, nil
}
