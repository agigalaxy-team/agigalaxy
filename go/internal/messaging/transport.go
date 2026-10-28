package messaging

import (
	"context"
	"crypto/tls"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"io"
	"net"
	"net/smtp"
	"net/textproto"
	"strconv"
	"strings"
	"time"
)

type TransportConfiguration struct {
	Host                                              string
	Port                                              int
	TLS                                               string
	ConnectionTimeout, GreetingTimeout, SocketTimeout time.Duration
}
type Credentials struct{ User, Password string }
type Submission struct {
	Submission string  `json:"submission"`
	Code       *string `json:"code"`
	Retryable  bool    `json:"retryable"`
}
type SMTPTransport struct {
	AllowLoopbackPlaintext bool
	TLSConfig              *tls.Config
	Now                    func() time.Time
}

func failed(code string, retryable bool) Submission {
	return Submission{Submission: "failed", Code: &code, Retryable: retryable}
}
func safeAuthorization(err error) string {
	code := fault.Code(err)
	switch code {
	case "operations_permission_denied", "business_admin_denied", "identity_directory_unavailable", "smtp_configuration_changed", "operations_messaging_not_active", "operations_messaging_recipient_ineligible", "operations_messaging_execution_interrupted":
		return code
	}
	return "smtp_authorization_changed"
}
func transportFailure(err error, bodyStarted bool, stage string) Submission {
	var reply *textproto.Error
	if errors.As(err, &reply) && reply.Code >= 400 && reply.Code <= 599 {
		if reply.Code < 500 {
			return failed("smtp_temporary_rejection", true)
		}
		return failed("smtp_permanent_rejection", false)
	}
	if bodyStarted {
		code := "smtp_submission_unknown"
		return Submission{Submission: "unknown", Code: &code, Retryable: false}
	}
	var timeout net.Error
	if errors.As(err, &timeout) && timeout.Timeout() {
		return failed("smtp_timeout", true)
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return failed("smtp_dns_failed", true)
	}
	var operation *net.OpError
	if errors.As(err, &operation) || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, net.ErrClosed) {
		return failed("smtp_connection_failed", true)
	}
	if stage == "auth" {
		return failed("smtp_authentication_failed", false)
	}
	if stage == "tls" {
		return failed("smtp_tls_failed", false)
	}
	var protocol textproto.ProtocolError
	if errors.As(err, &protocol) {
		return failed("smtp_protocol_failed", false)
	}
	if stage == "connect" {
		return failed("smtp_connection_failed", true)
	}
	return failed("smtp_transport_failed", false)
}

type loginAuth struct {
	user, password string
	step           int
}

func (a *loginAuth) Start(*smtp.ServerInfo) (string, []byte, error) { return "LOGIN", nil, nil }
func (a *loginAuth) Next(_ []byte, more bool) ([]byte, error) {
	if !more {
		return nil, nil
	}
	a.step++
	switch a.step {
	case 1:
		return []byte(a.user), nil
	case 2:
		return []byte(a.password), nil
	}
	return nil, fault.New("smtp_authentication_failed", 500)
}

// connected reuses the standard SMTP state machine. Authentication and envelope
// exchange remain sequential so the last live authorization is immediately
// after RCPT acknowledgment and before issuing DATA.
func (t SMTPTransport) connected(ctx context.Context, c TransportConfiguration, credentials Credentials, authorize func(context.Context) error, message *MailMessage) Submission {
	if authorize == nil {
		return failed("smtp_authorization_unavailable", false)
	}
	if c.Host == "" || c.Port < 1 || c.Port > 65535 || !oneTLS(c.TLS) {
		return failed("smtp_not_configured", false)
	}
	isolated := t.AllowLoopbackPlaintext && (c.Host == "127.0.0.1" || c.Host == "localhost")
	if c.ConnectionTimeout <= 0 {
		c.ConnectionTimeout = 10 * time.Second
	}
	if c.GreetingTimeout <= 0 {
		c.GreetingTimeout = 10 * time.Second
	}
	if c.SocketTimeout <= 0 {
		c.SocketTimeout = 30 * time.Second
	}
	conn, e := (&net.Dialer{Timeout: c.ConnectionTimeout}).DialContext(context.Background(), "tcp", net.JoinHostPort(c.Host, strconv.Itoa(c.Port)))
	if e != nil {
		return transportFailure(e, false, "connect")
	}
	defer conn.Close()
	secure := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: c.Host}
	if t.TLSConfig != nil {
		secure = t.TLSConfig.Clone()
		secure.ServerName = c.Host
		if secure.MinVersion < tls.VersionTLS12 {
			secure.MinVersion = tls.VersionTLS12
		}
		secure.InsecureSkipVerify = false
	}
	conn.SetDeadline(time.Now().Add(c.GreetingTimeout))
	if !isolated && c.TLS == "implicit" {
		wrapped := tls.Client(conn, secure)
		if e = wrapped.Handshake(); e != nil {
			return transportFailure(e, false, "tls")
		}
		conn = wrapped
	}
	client, e := smtp.NewClient(conn, c.Host)
	if e != nil {
		return transportFailure(e, false, "connect")
	}
	defer client.Close()
	conn.SetDeadline(time.Now().Add(c.SocketTimeout))
	if !isolated && c.TLS == "starttls" {
		if ok, _ := client.Extension("STARTTLS"); !ok {
			return failed("smtp_tls_failed", false)
		}
		if e = client.StartTLS(secure); e != nil {
			return transportFailure(e, false, "tls")
		}
	}
	if ok, methods := client.Extension("AUTH"); ok {
		var auth smtp.Auth
		switch {
		case strings.Contains(" "+methods+" ", " PLAIN "):
			auth = smtp.PlainAuth("", credentials.User, credentials.Password, c.Host)
		case strings.Contains(" "+methods+" ", " LOGIN "):
			auth = &loginAuth{user: credentials.User, password: credentials.Password}
		case strings.Contains(" "+methods+" ", " CRAM-MD5 "):
			auth = smtp.CRAMMD5Auth(credentials.User, credentials.Password)
		default:
			return failed("smtp_authentication_failed", false)
		}
		if e = client.Auth(auth); e != nil {
			return transportFailure(e, false, "auth")
		}
	} else {
		return failed("smtp_authentication_failed", false)
	}
	if message == nil {
		if e = authorize(ctx); e != nil {
			return failed(safeAuthorization(e), true)
		}
		return Submission{Submission: "connected"}
	}
	identity := OfficialMailIdentities[message.SenderKey]
	if e = client.Mail(identity.Address); e != nil {
		return transportFailure(e, false, "mail")
	}
	if e = client.Rcpt(message.To); e != nil {
		return transportFailure(e, false, "rcpt")
	}
	if e = authorize(ctx); e != nil {
		return failed(safeAuthorization(e), true)
	}
	writer, e := client.Data()
	if e != nil {
		return transportFailure(e, false, "data")
	}
	now := time.Now()
	if t.Now != nil {
		now = t.Now()
	}
	body, e := ComposeMail(*message, now)
	if e != nil {
		return failed("smtp_message_invalid", false)
	}
	if _, e = writer.Write(body); e != nil {
		return transportFailure(e, true, "body")
	}
	if e = writer.Close(); e != nil {
		return transportFailure(e, true, "body")
	}
	return Submission{Submission: "submitted"}
}
func oneTLS(value string) bool { return value == "implicit" || value == "starttls" }
func (t SMTPTransport) Verify(ctx context.Context, c TransportConfiguration, credentials Credentials, authorize func(context.Context) error) Submission {
	return t.connected(ctx, c, credentials, authorize, nil)
}
func (t SMTPTransport) Submit(ctx context.Context, c TransportConfiguration, credentials Credentials, authorize func(context.Context) error, message MailMessage) Submission {
	if len(message.To) > 320 || !emailPattern.MatchString(message.To) || !messageIDPattern.MatchString(message.MessageID) {
		return failed("smtp_message_invalid", false)
	}
	if _, ok := OfficialMailIdentities[message.SenderKey]; !ok {
		return failed("smtp_sender_invalid", false)
	}
	return t.connected(ctx, c, credentials, authorize, &message)
}
