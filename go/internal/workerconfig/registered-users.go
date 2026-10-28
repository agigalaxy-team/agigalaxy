package workerconfig

import (
	"context"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/registeredusers"
)

func (r *Runtime) registeredMaintenance(ctx context.Context) {
	if r.Registered == nil {
		return
	}
	at := time.Now()
	if !r.nextRegisteredSync.IsZero() && at.Before(r.nextRegisteredSync) {
		return
	}
	r.nextRegisteredSync = at.Add(time.Minute)
	if _, err := r.Registered.Sync(ctx); err != nil {
		maintenanceFailure(r.configuration, "registered-directory", err)
	}
}

func (r *Runtime) adoptRegistered(c Config) {
	if c.RegisteredDirectory == nil {
		return
	}
	r.Registered = &registeredusers.Directory{Pool: r.Pool, Endpoint: c.Endpoint, Reader: c.RegisteredDirectory, Accounts: &accounts.Service{Endpoint: c.Endpoint}}
}
