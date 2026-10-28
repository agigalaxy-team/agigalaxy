package systemsettings

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/maintenance"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

type boundaryRoute struct{ origin *url.URL }

func (t boundaryRoute) RoundTrip(req *http.Request) (*http.Response, error) {
	c := req.Clone(req.Context())
	u := *req.URL
	u.Scheme = t.origin.Scheme
	u.Host = t.origin.Host
	c.URL = &u
	return http.DefaultTransport.RoundTrip(c)
}

type unreadBody struct{}

func (unreadBody) Read([]byte) (int, error) { panic("unverified private request read its body") }
func (unreadBody) Close() error             { return nil }
func TestGeneralSourceOriginAndPrivateBodyBoundary(t *testing.T) {
	key := strings.Repeat("isolated-key-", 4)
	at := "2000000000"
	now := func() time.Time { return time.Unix(2000000000, 0) }
	native := &NativeClient{Client: maintenance.New(maintenance.Configuration{Key: key}, maintenance.Options{Now: now})}
	handler := Handler{Service: &Service{}, Native: native}
	for _, host := range []string{"192.0.2.1:1234", "127.0.0.2:1234", "127.0.0.1:1234"} {
		req := httptest.NewRequest("POST", "http://localhost/v1/internal/system-settings/authorize", nil)
		req.RemoteAddr = host
		req.Header.Set("Content-Type", "application/json")
		req.Body = unreadBody{}
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		if res.Code != 401 {
			t.Fatalf("private unverified host%s status%d", host, res.Code)
		}
	}
	raw := []byte(`{"actor":{"id":"forged","role":"administrator"}}`)
	req := httptest.NewRequest("POST", "http://localhost/v1/internal/system-settings/authorize", bytes.NewReader(raw))
	req.RemoteAddr = "127.0.0.1:1234"
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Galaxy-Service-Key", key)
	req.Header.Set("X-Galaxy-Request-Id", "11111111-1111-4111-8111-111111111111")
	req.Header.Set("X-Galaxy-Request-At", at)
	req.Header.Set("X-Galaxy-Service-Signature", maintenance.Signature(key, req.Header.Get("X-Galaxy-Request-Id"), at, raw))
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != 400 {
		t.Fatalf("signed body actor accepted %d", res.Code)
	}
	req.Body = io.NopCloser(strings.NewReader(string(raw) + " "))
	res = httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != 401 {
		t.Fatalf("changed exact body accepted %d", res.Code)
	}
	follow := 0
	redirect := true
	var markerVersion any = 1
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/site-publication.json" && redirect {
			http.Redirect(w, r, "/redirected", http.StatusFound)
			return
		}
		follow++
		json.NewEncoder(w).Encode(Object{"version": markerVersion, "publicationId": nil})
	}))
	defer server.Close()
	origin, _ := url.Parse(server.URL)
	general := &General{WebsiteOrigin: "https://website.example.invalid", Client: &http.Client{Transport: boundaryRoute{origin}}}
	if e := general.Validate(); e != nil {
		t.Fatal(e)
	}
	if _, e := general.marker(context.Background()); e == nil || follow != 0 {
		t.Fatal("source marker followed redirect")
	}
	redirect = false
	if value, e := general.marker(context.Background()); e != nil || value != nil {
		t.Fatalf("current marker %v %v", value, e)
	}
	markerVersion = 1.5
	if _, e := general.marker(context.Background()); e == nil {
		t.Fatal("nonliteral marker version accepted")
	}
	for _, origin := range []string{"https://website.example.invalid/", "https://WEBSITE.example.invalid", "http://website.example.invalid", "https://website.example.invalid/path"} {
		general.WebsiteOrigin = origin
		if general.Validate() == nil {
			t.Fatalf("non-explicit public website origin accepted %s", origin)
		}
	}
}
