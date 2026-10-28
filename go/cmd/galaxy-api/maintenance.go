package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/chat"
	"github.com/agigalaxy-team/agigalaxy/go/internal/incident"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/maintenance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
)

func maintenanceHandler(gateway *access.Gateway, duty operationspermissions.DutyAuthority, queue *jobs.Queue, rooms *chat.Service, incidentState *incident.Controller, settingsClient *maintenance.Client, next http.Handler) (http.Handler, *maintenance.Service, *maintenance.NativeClient, error) {
	// Usually settings and maintenance share a client. An explicitly separate
	// maintenance reference keeps its own configured socket and service key.
	client, err := nativeClientForReference(os.Getenv("GALAXY_MAINTENANCE_NATIVE_FILE"), systemSettingsNativePath(), settingsClient)
	if err != nil {
		return nil, nil, nil, err
	}
	native := &maintenance.NativeClient{Client: client}
	s := &maintenance.Service{Pool: gateway.Pool, Endpoint: gateway.Config.Endpoint, Authority: gateway, StoredAuthority: gateway.StoredOperators(), Duty: duty, PrincipalWithin: gateway.LockOperationsPrincipalWithin}
	if client != nil {
		s.Native = native
	}
	s.QueueSnapshot = func(ctx context.Context) (maintenance.Object, error) {
		return queue.Snapshot(ctx, gateway.Config.Endpoint)
	}
	s.ChatProbe = rooms.MaintenanceReadiness
	if incidentState != nil {
		s.IncidentSnapshot = func() maintenance.Object {
			raw, _ := json.Marshal(incidentState.Snapshot())
			var snapshot maintenance.Object
			_ = json.Unmarshal(raw, &snapshot)
			return snapshot
		}
	}
	return maintenance.Handler{Service: s, Native: native, Next: next}, s, native, nil
}

func nativeClientForReference(file, loadedFile string, loaded *maintenance.Client) (*maintenance.Client, error) {
	if file == loadedFile {
		return loaded, nil
	}
	configuration, err := maintenance.Load(file)
	if err != nil {
		return nil, err
	}
	if configuration == nil {
		return nil, nil
	}
	return maintenance.New(*configuration, maintenance.Options{}), nil
}
