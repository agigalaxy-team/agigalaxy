package messaging

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"strconv"
	"sync"
	"time"
)

type SMTPService struct {
	Pool                              *pgxpool.Pool
	Endpoint                          string
	Authority                         operationspermissions.Authority
	Directory                         DirectoryLookup
	Credentials                       CredentialResolver
	Transport                         SMTPTransport
	Now                               func() time.Time
	mu                                sync.Mutex
	active                            int
	rateVersion, rateStart, rateCount int64
	ResolveTXT                        func(context.Context, string) ([]string, error)
}
type MailRequest struct {
	AccountID, MessageID, SenderKey, Subject, Title string
	Paragraphs                                      []string
	Note, Language                                  string
	Authorize                                       func(context.Context) error
	Test                                            bool
}
type ProviderResult struct {
	Submission
	ConfigVersion *string `json:"configVersion"`
	NotSubmitted  bool    `json:"notSubmitted,omitempty"`
	RetryAt       *string `json:"retryAt,omitempty"`
}

func (s *SMTPService) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}
func emptySMTPConfiguration() Object {
	return Object{"enabled": false, "host": nil, "port": nil, "tls": nil, "credentialRef": nil, "connectionTimeoutMs": nil, "greetingTimeoutMs": nil, "socketTimeoutMs": nil, "maxConnections": nil, "rateLimit": nil, "rateWindowSeconds": nil, "dkimSelector": nil}
}
func completeSMTP(x Object) bool {
	for _, key := range []string{"host", "port", "tls", "credentialRef", "connectionTimeoutMs", "greetingTimeoutMs", "socketTimeoutMs", "maxConnections", "rateLimit", "rateWindowSeconds"} {
		if x[key] == nil {
			return false
		}
	}
	return true
}
func (s *SMTPService) current(ctx context.Context, db Reader) (Object, error) {
	row, e := one(ctx, db, "SELECT to_jsonb(s) FROM operations_smtp_settings_v1 s WHERE endpoint=$1", s.Endpoint)
	if errors.Is(e, pgx.ErrNoRows) {
		return Object{"version": 0, "configuration": emptySMTPConfiguration(), "updatedAt": nil, "updatedBy": nil}, nil
	}
	if e != nil {
		return nil, e
	}
	return Object{"version": row["version"], "configuration": row["configuration"], "updatedAt": stamp(row["updated_at"]), "updatedBy": row["updated_by"]}, nil
}
func (s *SMTPService) Status(ctx context.Context) (Object, error) {
	current, e := s.current(ctx, s.Pool)
	if e != nil {
		return nil, e
	}
	return s.status(current), nil
}
func (s *SMTPService) status(current Object) Object {
	x := obj(current["configuration"])
	available := false
	if completeSMTP(x) && s.Credentials != nil {
		credentials, e := s.Credentials.Resolve(CredentialSelection{Ref: str(x["credentialRef"]), Host: str(x["host"]), Port: int(num(x["port"])), TLS: str(x["tls"])})
		available = e == nil && credentials != nil
	}
	state := "not-configured"
	var version any
	if num(current["version"]) > 0 {
		version = strconv.FormatInt(num(current["version"]), 10)
		if completeSMTP(x) && available {
			state = "configured"
		}
	}
	return Object{"state": state, "enabled": boolValue(x["enabled"]), "configVersion": version, "receipts": "not-connected", "credentialAvailable": available}
}
func (s *SMTPService) recipient(ctx context.Context, accountID string) (string, error) {
	if s.Directory == nil {
		return "", nil
	}
	row, e := one(ctx, s.Pool, `SELECT jsonb_build_object('issuer',issuer,'externalSubject',external_subject) FROM community_accounts WHERE endpoint=$1 AND id=$2`, s.Endpoint, accountID)
	if errors.Is(e, pgx.ErrNoRows) {
		return "", nil
	}
	if e != nil {
		return "", e
	}
	identity, e := s.Directory(ctx, str(row["issuer"]), str(row["externalSubject"]))
	if e != nil {
		return "", failure("identity_directory_unavailable", 503)
	}
	if identity.State != "available" || identity.Issuer != str(row["issuer"]) || identity.ExternalSubject != str(row["externalSubject"]) || !identity.Enabled || !identity.EmailVerified || len(identity.Email) > 320 || !emailPattern.MatchString(identity.Email) {
		return "", nil
	}
	return identity.Email, nil
}
func smtpSafeAuthorization(err error) string {
	code := fault.Code(err)
	switch code {
	case "smtp_credential_binding_mismatch", "smtp_configuration_changed", "operations_permission_denied", "business_admin_denied", "identity_directory_unavailable", "operations_messaging_not_active", "operations_messaging_recipient_ineligible", "operations_messaging_execution_interrupted":
		return code
	}
	return "smtp_authorization_changed"
}
func (s *SMTPService) withPermit(current Object, operation func() Submission) ProviderResult {
	x := obj(current["configuration"])
	now := s.now().Unix()
	s.mu.Lock()
	if s.active >= int(num(x["maxConnections"])) {
		s.mu.Unlock()
		retry := iso(time.Unix(now+30, 0))
		return ProviderResult{Submission: failed("smtp_concurrency_limited", true), NotSubmitted: true, RetryAt: &retry}
	}
	version := num(current["version"])
	if s.rateVersion != version || now-s.rateStart >= num(x["rateWindowSeconds"]) {
		s.rateVersion = version
		s.rateStart = now
		s.rateCount = 0
	}
	if s.rateCount >= num(x["rateLimit"]) {
		retry := iso(time.Unix(s.rateStart+num(x["rateWindowSeconds"]), 0))
		s.mu.Unlock()
		return ProviderResult{Submission: failed("smtp_rate_limited", true), NotSubmitted: true, RetryAt: &retry}
	}
	s.active++
	s.rateCount++
	s.mu.Unlock()
	defer func() { s.mu.Lock(); s.active--; s.mu.Unlock() }()
	return ProviderResult{Submission: operation()}
}
func transportConfiguration(x Object) TransportConfiguration {
	return TransportConfiguration{Host: str(x["host"]), Port: int(num(x["port"])), TLS: str(x["tls"]), ConnectionTimeout: time.Duration(num(x["connectionTimeoutMs"])) * time.Millisecond, GreetingTimeout: time.Duration(num(x["greetingTimeoutMs"])) * time.Millisecond, SocketTimeout: time.Duration(num(x["socketTimeoutMs"])) * time.Millisecond}
}
func (s *SMTPService) Submit(ctx context.Context, input MailRequest) (ProviderResult, error) {
	current, e := s.current(ctx, s.Pool)
	if e != nil {
		return ProviderResult{}, e
	}
	x := obj(current["configuration"])
	var configVersion *string
	if n := num(current["version"]); n > 0 {
		value := strconv.FormatInt(n, 10)
		configVersion = &value
	}
	finish := func(result Submission) (ProviderResult, error) {
		return ProviderResult{Submission: result, ConfigVersion: configVersion}, nil
	}
	if input.Authorize == nil {
		return finish(failed("smtp_authorization_unavailable", false))
	}
	if num(current["version"]) == 0 || !completeSMTP(x) || !boolValue(x["enabled"]) && !input.Test {
		result := failed("smtp_not_configured", false)
		result.Submission = "not-configured"
		return finish(result)
	}
	if _, ok := OfficialMailIdentities[input.SenderKey]; !ok {
		return finish(failed("smtp_sender_invalid", false))
	}
	if e = input.Authorize(ctx); e != nil {
		return finish(failed(smtpSafeAuthorization(e), fault.Code(e) != "smtp_credential_binding_mismatch"))
	}
	if s.Credentials == nil {
		result := failed("smtp_credential_unavailable", false)
		result.Submission = "not-configured"
		return finish(result)
	}
	credentials, e := s.Credentials.Resolve(CredentialSelection{Ref: str(x["credentialRef"]), Host: str(x["host"]), Port: int(num(x["port"])), TLS: str(x["tls"]), Purpose: input.SenderKey})
	if e != nil {
		return finish(failed(smtpSafeAuthorization(e), fault.Code(e) != "smtp_credential_binding_mismatch"))
	}
	if credentials == nil {
		result := failed("smtp_credential_unavailable", false)
		result.Submission = "not-configured"
		return finish(result)
	}
	to, e := s.recipient(ctx, input.AccountID)
	if e != nil {
		return finish(failed(smtpSafeAuthorization(e), true))
	}
	if to == "" {
		result := failed("smtp_recipient_ineligible", false)
		result.Submission = "ineligible"
		return finish(result)
	}
	fresh := func(c context.Context) error {
		if e := input.Authorize(c); e != nil {
			return e
		}
		latest, e := s.current(c, s.Pool)
		if e != nil {
			return e
		}
		if num(latest["version"]) != num(current["version"]) || !input.Test && !boolValue(obj(latest["configuration"])["enabled"]) {
			return failure("smtp_configuration_changed")
		}
		value, e := s.recipient(c, input.AccountID)
		if e != nil {
			return e
		}
		if value != to {
			return failure("operations_messaging_recipient_ineligible")
		}
		return nil
	}
	result := s.withPermit(current, func() Submission {
		return s.Transport.Submit(ctx, transportConfiguration(x), *credentials, fresh, MailMessage{To: to, MessageID: input.MessageID, SenderKey: input.SenderKey, Subject: input.Subject, Title: input.Title, Paragraphs: input.Paragraphs, Note: input.Note, Language: input.Language})
	})
	result.ConfigVersion = configVersion
	return result, nil
}
