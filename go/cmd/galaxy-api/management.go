package main

import (
	"net/http"
	"os"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/managementaccounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
)

func managementHandler(gateway *access.Gateway, permissions *operationspermissions.Service, next http.Handler) (http.Handler, error) {
	directory, err := access.LoadManagementDirectory(os.Getenv("GALAXY_OPERATIONS_CONFIG_FILE"))
	if err != nil {
		return nil, err
	}
	service := &managementaccounts.Service{Pool: gateway.Pool, Endpoint: gateway.Config.Endpoint, Authority: gateway, Permissions: permissions, Sessions: gateway.ManagementSessions(), Now: gateway.Now}
	if directory != nil {
		service.Directory = directory
	}
	if root := gateway.Config.Root; root != nil {
		service.Root = &managementaccounts.Root{OperatorID: root.OperatorID, Endpoint: gateway.Config.Endpoint, Issuer: root.Issuer, ExternalSubject: root.Subject}
	}
	return managementaccounts.Handler{Service: service, Next: next}, nil
}
