package native

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type serviceConfigurationTransport struct {
	raw        string
	status     int
	requests   int
	badHeaders bool
}

func (t *serviceConfigurationTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	t.requests++
	if request.Method != "GET" || request.URL.String() != "https://configuration.invalid/galaxy-web-config.json" || request.Header.Get("Authorization") != "" || request.Header.Get("Cookie") != "" || request.Header.Get("Cache-Control") != "no-store" {
		t.badHeaders = true
	}
	status := t.status
	if status == 0 {
		status = 200
	}
	return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(t.raw)), Request: request}, nil
}
func TestServiceConfigurationPreservesSelection(t *testing.T) {
	public, _, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	pem, e := identity.PublicPEM(public)
	if e != nil {
		t.Fatal(e)
	}
	const now = int64(2000000000)
	pin := func(key string) map[string]any {
		return map[string]any{"kid": "fixture", "publicKeyPem": key, "notBefore": now - 30, "notAfter": now + 3600, "revoked": false}
	}
	source := func(keys []any) map[string]any {
		return map[string]any{"version": 1, "endpoint": "https://api.configuration.invalid", "operator": "isolated public operator", "signingKeys": keys}
	}
	raw := func(value any) string {
		b, e := protocol.Encode(value)
		if e != nil {
			t.Fatal(e)
		}
		return string(b)
	}
	base := raw(source([]any{pin(pem)}))
	tail := pem + " \t\r\n\ufeff"
	duplicate := source([]any{pin(pem), pin(pem)})
	revoked := pin(pem)
	revoked["revoked"] = true
	future := pin(pem)
	future["notBefore"] = now + 60
	unknown := source([]any{pin(pem)})
	unknown["unasked"] = true
	controlKid := pin(pem)
	controlKid["kid"] = "invalid\x00kid"
	deleteOperator := source([]any{pin(pem)})
	delete(deleteOperator, "operator")
	negative := pin(pem)
	negative["notBefore"] = -100
	cases := []string{base, raw(source([]any{pin(tail)})), strings.Replace(base, `"version":1`, `"version":1.0`, 1), raw(duplicate), raw(source([]any{revoked})), raw(source([]any{future})), raw(unknown), raw(source([]any{pin(pem + "\u200b")})), raw(source([]any{controlKid})), raw(deleteOperator), raw(source([]any{negative}))}
	folder := t.TempDir()
	wantAccepted := []bool{true, true, true, false, false, false, false, false, false, true, true}
	options := ServiceConfigurationOptions{Now: func() time.Time { return time.Unix(now, 0) }}
	request := ServiceConfigurationRequest{Website: "https://configuration.invalid", Endpoint: "https://api.configuration.invalid"}
	for i, body := range cases {
		transport := &serviceConfigurationTransport{raw: body}
		options.HTTPClient = &http.Client{Transport: transport}
		_, e := InspectServiceConfiguration(context.Background(), request, options)
		if (e == nil) != wantAccepted[i] {
			t.Fatalf("public config case %d acceptance mismatch: %v", i, e)
		}
		if transport.requests != 1 || transport.badHeaders {
			t.Fatal("public configuration used credentials or another origin")
		}
	}
	if _, e = connectionPublicPEM(tail); e != nil || connectionCanonicalPublic(tail) || !connectionCanonicalPublic(pem) {
		t.Fatal("public pin tail compatibility loosened device canonical checks")
	}
	if _, e = connectionPublicPEM(pem + "\u200b"); e == nil {
		t.Fatal("arbitrary invisible public key tail accepted")
	}
	transport := &serviceConfigurationTransport{raw: base}
	options.HTTPClient = &http.Client{Transport: transport}
	request.DataDirectory = filepath.Join(folder, "not-created")
	request.Output = filepath.Join(folder, "native-config.json")
	result, e := PrepareServiceConfiguration(context.Background(), request, options)
	if e != nil {
		t.Fatal(e)
	}
	if uploadObject(result)["connected"] != false || uploadObject(result)["identityCreated"] != false || uploadObject(result)["dataDirectoryCreated"] != false {
		t.Fatal("configuration write claimed identity or connection")
	}
	if present, e := exists(request.DataDirectory); e != nil || present {
		t.Fatal("configuration prep initialized a data directory")
	}
	saved, e := os.ReadFile(request.Output)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = ReadConfiguration(request.Output); e != nil {
		t.Fatal(e)
	}
	if _, e = PrepareServiceConfiguration(context.Background(), request, options); !os.IsExist(e) {
		t.Fatalf("existing configuration overwritten: %v", e)
	}
	after, e := os.ReadFile(request.Output)
	if e != nil || string(after) != string(saved) {
		t.Fatal("original configured selection changed")
	}
	request.Endpoint = "https://other.invalid"
	if _, e = PrepareServiceConfiguration(context.Background(), request, options); e == nil {
		t.Fatal("selected endpoint replaced by website metadata")
	}
	for _, bad := range []string{"https://user:password@configuration.invalid", "https://configuration.invalid/", "https://CONFIGURATION.invalid", "https://configuration.invalid:443"} {
		request.Website = bad
		count := transport.requests
		if _, e = InspectServiceConfiguration(context.Background(), request, options); e == nil || transport.requests != count {
			t.Fatal("invalid explicit origin issued a request")
		}
	}
	request.Website = "https://configuration.invalid"
	request.Endpoint = "https://api.configuration.invalid"
	transport.raw = strings.Repeat("x", 16385)
	if _, e = InspectServiceConfiguration(context.Background(), request, options); e == nil {
		t.Fatal("unbounded public configuration accepted")
	}
	transport.raw = base
	transport.status = 302
	if _, e = InspectServiceConfiguration(context.Background(), request, options); e == nil {
		t.Fatal("public configuration redirect accepted")
	}
}

type serviceConfigurationFailureTransport struct{ err error }

func (t serviceConfigurationFailureTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, t.err
}

func TestServiceConfigurationOfflineClassification(t *testing.T) {
	request := ServiceConfigurationRequest{Website: "https://configuration.invalid"}
	for _, tc := range []struct {
		name      string
		transport http.RoundTripper
		want      string
	}{
		{"temporary network", serviceConfigurationFailureTransport{&net.DNSError{Err: "temporary", Name: "configuration.invalid", IsTimeout: true}}, "native_service_configuration_temporarily_unavailable"},
		{"unknown domain", serviceConfigurationFailureTransport{&net.DNSError{Err: "not found", Name: "configuration.invalid", IsNotFound: true}}, "native_service_configuration_unavailable"},
		{"deadline", serviceConfigurationFailureTransport{context.DeadlineExceeded}, "native_service_configuration_temporarily_unavailable"},
		{"certificate", serviceConfigurationFailureTransport{&tls.CertificateVerificationError{Err: x509.UnknownAuthorityError{}}}, "native_service_configuration_unavailable"},
		{"tls protocol", serviceConfigurationFailureTransport{tls.RecordHeaderError{}}, "native_service_configuration_unavailable"},
		{"service unavailable", &serviceConfigurationTransport{status: 503}, "native_service_configuration_temporarily_unavailable"},
		{"client error", &serviceConfigurationTransport{status: 404}, "native_service_configuration_unavailable"},
		{"rate limit", &serviceConfigurationTransport{status: 429}, "native_service_configuration_unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := InspectServiceConfiguration(context.Background(), request, ServiceConfigurationOptions{HTTPClient: &http.Client{Transport: tc.transport}})
			if fault.Code(err) != tc.want {
				t.Fatalf("got %v, want %s", err, tc.want)
			}
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := InspectServiceConfiguration(ctx, request, ServiceConfigurationOptions{HTTPClient: &http.Client{Transport: serviceConfigurationFailureTransport{context.Canceled}}})
	if err != context.Canceled {
		t.Fatalf("canceled request: %v", err)
	}
}
