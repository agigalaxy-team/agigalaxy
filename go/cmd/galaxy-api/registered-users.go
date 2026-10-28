package main

import (
	"context"
	"net/http"
	"os"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/registeredusers"
)

type registeredPortal struct{ gateway *access.Gateway }

func registeredPortalResult(value any, err error) (registeredusers.Object, error) {
	if err != nil {
		return nil, err
	}
	out, ok := value.(map[string]any)
	if !ok {
		return nil, fault.New("registered_user_portal_unavailable", 503)
	}
	return out, nil
}
func (p registeredPortal) Summary(ctx context.Context, issuer, subject string) (registeredusers.Object, error) {
	return registeredPortalResult(p.gateway.AccountSessionSummary(ctx, issuer, subject))
}
func (p registeredPortal) Revoke(ctx context.Context, issuer, subject string, accountID *string) (registeredusers.Object, error) {
	id := ""
	if accountID != nil {
		id = *accountID
	}
	return registeredPortalResult(p.gateway.RevokeAccountSessions(ctx, id, issuer, subject))
}

func registeredUsersHandler(gateway *access.Gateway, accountService *accounts.Service, next http.Handler, loaded ...func(*registeredusers.Service)) (http.Handler, error) {
	native, err := access.LoadRegisteredDirectory(os.Getenv("GALAXY_OPERATIONS_CONFIG_FILE"), true, gateway.Config.AccountIssuer)
	if err != nil {
		return nil, err
	}
	service := &registeredusers.Service{Pool: gateway.Pool, Endpoint: gateway.Config.Endpoint, Authority: gateway, Accounts: accountService, Portal: registeredPortal{gateway}}
	if native != nil {
		service.Directory = native
	}
	for _, capture := range loaded {
		capture(service)
	}
	return registeredusers.Handler{Service: service, Next: next}, nil
}
