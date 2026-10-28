package main

import (
	"net/http"
	"os"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/maintenance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsmodels"
)

func modelSettingsHandler(gateway *access.Gateway, maintenanceClient *maintenance.Client, next http.Handler) (http.Handler, *operationsmodels.NativeClient, error) {
	path, present := os.LookupEnv("GALAXY_MODEL_SETTINGS_NATIVE_FILE")
	if !present {
		path = os.Getenv("GALAXY_MAINTENANCE_NATIVE_FILE")
	}
	client, err := nativeClientForReference(path, os.Getenv("GALAXY_MAINTENANCE_NATIVE_FILE"), maintenanceClient)
	if err != nil {
		return nil, nil, err
	}
	native := &operationsmodels.NativeClient{Client: client}
	s := &operationsmodels.Service{Pool: gateway.Pool, Endpoint: gateway.Config.Endpoint, Authority: gateway, StoredAuthority: gateway.StoredOperators()}
	if client != nil {
		s.Native = native
	}
	return operationsmodels.Handler{Service: s, Native: native, Next: next}, native, nil
}
