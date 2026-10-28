package main

import (
	"context"
	"net/http"
	"os"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identityreturn"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
)

func identityLinksHandler(ctx context.Context, registry *accountlinks.Service, policy *resourcebudget.Policy, next http.Handler, loaded ...func([]accountlinks.LoginProvider)) (http.Handler, error) {
	if registry.Devices == nil {
		return accountlinks.Handler{Next: next}, nil
	}
	providers, err := accountlinks.LoadProviders(ctx, registry.Pool, registry.Endpoint, os.Getenv("GALAXY_IDENTITY_CONFIG_FILE"), os.Getenv)
	if err != nil {
		return nil, err
	}
	for _, capture := range loaded {
		capture(providers)
	}
	links, err := accountlinks.NewLinks(registry, providers, policy)
	if err != nil {
		return nil, err
	}
	return identityreturn.New(identityreturn.Options{
		Endpoint: registry.Endpoint,
		Callback: func(ctx context.Context, provider, returned string) (string, error) {
			result, err := links.Callback(ctx, provider, returned)
			if err != nil {
				return "", err
			}
			state, ok := result["state"].(string)
			if !ok {
				return "", fault.New("identity_callback_result_invalid", 500)
			}
			return state, nil
		},
		Next: accountlinks.Handler{Links: links, Next: next},
	})
}
