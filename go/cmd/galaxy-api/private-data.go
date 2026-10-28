package main

import (
	"context"
	"net/http"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountarchive"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func privateDataHandler(pool *pgxpool.Pool, endpoint string, devices *deviceauth.Service, links *accountlinks.Service, profiles *accounts.Service, identity accounts.HTTPIdentity, budget *resourcebudget.Service, next http.Handler) (http.Handler, error) {
	service := &accountarchive.Service{Pool: pool, Endpoint: endpoint, Registry: links, Profiles: profiles}
	var deviceIdentity accountarchive.DeviceIdentity
	if devices != nil {
		service.Devices = devices
		deviceIdentity = devices
	}
	service.ResourceWrite = func(ctx context.Context, tx pgx.Tx, actor deviceauth.Actor, authorize func() error, operation func() (accountarchive.Object, error)) (accountarchive.Object, error) {
		result, err := budget.ResourceWrite(ctx, tx, resourcebudget.Actor{SubjectID: actor.SubjectID},
			func(context.Context, pgx.Tx) error { return authorize() },
			func(context.Context, pgx.Tx) (any, error) { return operation() }, resourcebudget.Options{})
		if err != nil {
			return nil, err
		}
		value, ok := result.(map[string]any)
		if !ok {
			return nil, fault.New("account_work_result_invalid", 500)
		}
		return value, nil
	}
	return accountarchive.Handler{Service: service, Devices: deviceIdentity, Identity: identity, Next: next}, nil
}
