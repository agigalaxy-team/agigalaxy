package publicfetch

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"time"
	"unicode/utf8"
)

// PostHubPeering is only the original bounded signed read-only exchange. It
// carries no Galaxy credential and cannot target another route or payload kind.
func PostHubPeering(ctx context.Context, address string, body []byte, maxBytes int, timeout time.Duration) ([]byte, error) {
	if !ValidURL(address) || len(body) > 32768 || !utf8.Valid(body) || maxBytes < 1 || maxBytes > 1048576 || timeout < time.Millisecond || timeout > 30*time.Second {
		return nil, errors.New("invalid peering query")
	}
	u, e := url.Parse(address)
	if e != nil || u.EscapedPath() != "/v2/hubs/peering/exchange" {
		return nil, errors.New("invalid peering query")
	}
	var v map[string]json.RawMessage
	var signed string
	if json.Unmarshal(body, &v) != nil || len(v) != 1 || json.Unmarshal(v["signed"], &signed) != nil {
		return nil, errors.New("invalid peering query")
	}
	return publicScopedJSON(ctx, address, body, maxBytes, timeout, false)
}
