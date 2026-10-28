// Package messagingconfig assembles the existing official-message consumers.
// Reading protected references does not send mail, enable a plan or claim jobs.
package messagingconfig

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/messaging"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Configuration struct {
	Endpoint    string
	Directory   *access.KeycloakDirectory
	Credentials messaging.CredentialResolver
}

func Load(endpoint, operationsFile, credentialsFile string) (*Configuration, error) {
	directory, err := access.LoadAccountDirectory(operationsFile)
	if err != nil {
		return nil, err
	}
	credentials, err := messaging.LoadCredentials("", endpoint)
	if credentialsFile != "" {
		credentials, err = messaging.NewRefreshingCredentials(credentialsFile, endpoint)
	}
	if err != nil {
		return nil, err
	}
	return &Configuration{Endpoint: endpoint, Directory: directory, Credentials: credentials}, nil
}

func (c *Configuration) Services(pool *pgxpool.Pool, authority operationspermissions.Authority, approver messaging.ApprovalAuthority) (*messaging.Service, *messaging.SMTPService) {
	var lookup messaging.DirectoryLookup
	if c.Directory != nil {
		lookup = func(ctx context.Context, issuer, subject string) (messaging.DirectoryIdentity, error) {
			value, err := c.Directory.LookupIdentity(ctx, issuer, subject)
			if err != nil {
				return messaging.DirectoryIdentity{}, err
			}
			return messaging.DirectoryIdentity{Issuer: value.Issuer, ExternalSubject: value.ExternalSubject, State: value.State, Email: value.Email, Enabled: value.Enabled, EmailVerified: value.EmailVerified}, nil
		}
	}
	mail := &messaging.SMTPService{Pool: pool, Endpoint: c.Endpoint, Authority: authority, Directory: lookup, Credentials: c.Credentials, Transport: messaging.SMTPTransport{}}
	service := &messaging.Service{Pool: pool, Endpoint: c.Endpoint, Authority: authority, Approver: approver, Directory: lookup, Mail: mail}
	return service, mail
}
