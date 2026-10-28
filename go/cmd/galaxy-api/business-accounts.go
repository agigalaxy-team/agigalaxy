package main

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsaccounts"
)

func businessAccountsService(domain *businessadmin.Domain, accountsService *accounts.Service, directory *access.KeycloakDirectory) *operationsaccounts.Service {
	service := &operationsaccounts.Service{Domain: domain, Accounts: accountsService}
	if directory != nil {
		service.LookupIdentity = func(ctx context.Context, issuer, subject string) (operationsaccounts.Object, error) {
			value, err := directory.LookupIdentity(ctx, issuer, subject)
			if err != nil {
				return nil, err
			}
			return operationsaccounts.Object{"issuer": value.Issuer, "externalSubject": value.ExternalSubject, "state": value.State, "email": value.Email, "emailVerified": value.EmailVerified, "enabled": value.Enabled}, nil
		}
		service.FindByEmail = func(ctx context.Context, email string) ([]operationsaccounts.Object, error) {
			values, err := directory.FindByEmail(ctx, email)
			if err != nil {
				return nil, err
			}
			out := make([]operationsaccounts.Object, 0, len(values))
			for _, value := range values {
				out = append(out, operationsaccounts.Object{"issuer": value.Issuer, "externalSubject": value.ExternalSubject, "state": value.State, "email": value.Email, "emailVerified": value.EmailVerified, "enabled": value.Enabled})
			}
			return out, nil
		}
	}
	return service
}
