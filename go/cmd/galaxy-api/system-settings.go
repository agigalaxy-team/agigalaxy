package main

import (
	"net/http"
	"os"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/maintenance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/messaging"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publication"
	"github.com/agigalaxy-team/agigalaxy/go/internal/systemsettings"
)

func systemSettingsNativePath() string {
	path, present := os.LookupEnv("GALAXY_SYSTEM_SETTINGS_NATIVE_FILE")
	if !present {
		path = os.Getenv("GALAXY_MAINTENANCE_NATIVE_FILE")
	}
	return path
}

func systemSettingsHandler(gateway *access.Gateway, mail *messaging.SMTPService, publications *publication.Commands, next http.Handler, loaded ...func(*systemsettings.Service, *systemsettings.General)) (http.Handler, *systemsettings.NativeClient, error) {
	path := systemSettingsNativePath()
	configuration, err := maintenance.Load(path)
	if err != nil {
		return nil, nil, err
	}
	var client *maintenance.Client
	if configuration != nil {
		client = maintenance.New(*configuration, maintenance.Options{})
	}
	native := &systemsettings.NativeClient{Client: client}
	service := &systemsettings.Service{Pool: gateway.Pool, Endpoint: gateway.Config.Endpoint, Authority: gateway, StoredAuthority: gateway.StoredOperators()}
	if client != nil {
		service.Native = native
	}
	general := &systemsettings.General{Settings: service, Publications: publications, WebsiteOrigin: gateway.Config.WebsiteOrigin}
	if err = general.Validate(); err != nil {
		return nil, nil, err
	}
	for _, capture := range loaded {
		capture(service, general)
	}
	return systemsettings.Handler{Service: service, General: general, Mail: &systemsettings.MailBridge{Settings: service, SMTP: mail}, Native: native, Next: next}, native, nil
}
