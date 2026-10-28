package portal

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"sync"
)

// OIDCLoader postpones discovery until a login or credential refresh needs it.
// A temporary provider outage does not invalidate otherwise usable sessions.
type OIDCLoader struct {
	configuration OIDCConfig
	mu            sync.Mutex
	provider      *OIDCProvider
}

func NewOIDCLoader(c OIDCConfig) (*OIDCLoader, error) {
	if _, e := secureURL(c.Issuer, c.AllowLoopbackHTTP); e != nil {
		return nil, e
	}
	if c.ClientID == "" || protocol.TextLength(c.ClientID) > 200 || len(c.AllowedOrigins) > 8 {
		return nil, fault.New("oidc_configuration_invalid", 400)
	}
	for _, origin := range c.AllowedOrigins {
		u, e := secureURL(origin, c.AllowLoopbackHTTP)
		if e != nil || u.Path != "" {
			return nil, fault.New("oidc_configuration_invalid", 400)
		}
	}
	c.AllowedOrigins = append([]string(nil), c.AllowedOrigins...)
	return &OIDCLoader{configuration: c}, nil
}
func (l *OIDCLoader) Get(ctx context.Context) (*OIDCProvider, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	if l.provider != nil {
		return l.provider, nil
	}
	p, e := NewOIDC(ctx, l.configuration)
	if e != nil {
		return nil, e
	}
	l.provider = p
	return p, nil
}
func (l *OIDCLoader) Refresh(ctx context.Context, r RefreshRequest) (Tokens, error) {
	p, e := l.Get(ctx)
	if e != nil {
		return Tokens{}, e
	}
	return p.Refresh(ctx, r)
}
