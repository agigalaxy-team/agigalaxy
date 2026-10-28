package messaging

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
)

// ParseSMTPConfiguration is the same closed configuration contract used by the
// original SMTP command. Configuration consumers do not acquire a send/test API.
func ParseSMTPConfiguration(input any) (Object, error) { return normalizeSMTP(input) }

// ParseConfiguration is the same current message/draft contract used by Save.
func ParseConfiguration(input any) (Object, error) { return normalizeConfig(input) }
func (s *SMTPService) CurrentWithin(ctx context.Context, db Reader) (Object, error) {
	return s.current(ctx, db)
}
func (s *SMTPService) StatusOf(current Object) Object { return s.status(current) }

// SaveWithAuthority supports the original trusted system-settings mail bridge.
// The owning controller must revalidate its exact stored-version apply proof and
// map only smtp.configure. No authority is accepted from an HTTP/model payload,
// no live sender state or mutex is copied, and this call never tests/sends mail.
func (s *SMTPService) SaveWithAuthority(ctx context.Context, actor Actor, input Object, authority operationspermissions.Authority) (Object, error) {
	scoped := &SMTPService{Pool: s.Pool, Endpoint: s.Endpoint, Authority: authority, Credentials: s.Credentials, Now: s.Now}
	return scoped.Save(ctx, actor, input)
}
