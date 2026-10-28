package main

import (
	"net/http"
	"os"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/httpboundary"
)

func loadHTTPBoundaryConfiguration(gateway *access.Gateway) (httpboundary.Config, string, string, error) {
	browser, err := httpboundary.LoadBrowserPolicy(os.Getenv("GALAXY_BROWSER_POLICY_FILE"))
	if err != nil {
		return httpboundary.Config{}, "", "", err
	}
	quota, err := httpboundary.LoadQuotaPolicy(os.Getenv("GALAXY_REQUEST_QUOTA_FILE"))
	if err != nil {
		return httpboundary.Config{}, "", "", err
	}
	origins := append(append([]string{}, browser.Origins...), gateway.Config.AdminOrigin)
	var proxies []string
	if raw := os.Getenv("GALAXY_TRUSTED_PROXY_ADDRESSES"); raw != "" {
		for _, address := range strings.Split(raw, ",") {
			proxies = append(proxies, strings.TrimSpace(address))
		}
	}
	q, e := loadedJSONHash(quota)
	if e != nil {
		return httpboundary.Config{}, "", "", e
	}
	b, e := loadedJSONHash(browser)
	if e != nil {
		return httpboundary.Config{}, "", "", e
	}
	return httpboundary.Config{Endpoint: gateway.Config.Endpoint, Origins: origins, TrustedProxyAddresses: proxies, QuotaPolicy: quota, AccountQuotaSession: gateway.AccountQuotaSession}, q, b, nil
}
func httpBoundary(gateway *access.Gateway, next http.Handler, privateService func(*http.Request) error, loaded ...httpboundary.Config) (http.Handler, error) {
	var configuration httpboundary.Config
	if len(loaded) > 0 {
		configuration = loaded[0]
	} else {
		var err error
		configuration, _, _, err = loadHTTPBoundaryConfiguration(gateway)
		if err != nil {
			return nil, err
		}
	}
	configuration.VerifyPrivateService = privateService
	boundary, err := httpboundary.New(configuration)
	if err != nil {
		return nil, err
	}
	return boundary.Handler(next), nil
}
