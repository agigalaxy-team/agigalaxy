package maintenance

import (
	"context"
	"encoding/json"
	"time"
)

// ModelSettings shares the protected transport and exposes only the existing
// closed native path. Its owning model service validates commands before call.
func (c *Client) ModelSettings(ctx context.Context, raw []byte) (json.RawMessage, int, error) {
	return c.call(ctx, "/v1/model-settings", raw, 4194304, 20*time.Second)
}
