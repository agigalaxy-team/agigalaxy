package main

import (
	"context"
	"net/http"
	"os"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discoveryconfig"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
)

func discoveryHandler(ctx context.Context, gateway *access.Gateway, forum *community.Service, identity accounts.HTTPIdentity, duty operationspermissions.DutyAuthority, next http.Handler) (http.Handler, *discovery.Runtime, *discovery.Configuration, error) {
	cfg, err := discovery.LoadConfiguration(os.Getenv("GALAXY_DISCOVERY_CONFIG_FILE"), forum.Endpoint)
	if err != nil {
		return nil, nil, nil, err
	}
	if cfg == nil {
		return next, nil, nil, nil
	}
	authority := &operationspermissions.BusinessAuthority{Human: gateway, Duty: duty}
	runtime, err := discoveryconfig.Runtime(forum.Pool, forum.Endpoint, cfg, forum, false, authority)
	if err != nil {
		return nil, nil, nil, err
	}
	if _, err = runtime.Initialize(ctx); err != nil {
		return nil, nil, nil, err
	}
	return discovery.Handler{Runtime: runtime, Quality: runtime.SearchQuality, Recommendations: runtime.Recommendations, Authority: gateway, Accounts: identity, CurrentAccount: func(r *http.Request) (bool, error) {
		id, _, err := gateway.AccountQuotaSession(r)
		return id != "", err
	}, WebsiteOrigin: cfg.WebsiteOrigin, VisitorSecret: cfg.VisitorSecret, Next: next}, runtime, cfg, nil
}
