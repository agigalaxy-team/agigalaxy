package discovery

import (
	"context"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
)

type nativeRoundTripper func(*http.Request) (*http.Response, error)

func (f nativeRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestNativeClientHasNoAmbientProxyOrCookies(t *testing.T) {
	var proxies, requests atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { proxies.Add(1); w.WriteHeader(502) }))
	defer proxy.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Header.Get("Cookie") != "" {
			t.Error("ambient cookie escaped")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{}`))
	}))
	defer server.Close()
	jar, _ := cookiejar.New(nil)
	u, _ := url.Parse(server.URL)
	jar.SetCookies(u, []*http.Cookie{{Name: "private", Value: "synthetic"}})
	p, _ := url.Parse(proxy.URL)
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = http.ProxyURL(p)
	supplied := &http.Client{Transport: transport, Jar: jar}
	client, e := newNative(server.URL, nil, ClientOptions{HTTP: supplied})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = client.call(context.Background(), "/", "GET", nil, false); e != nil {
		t.Fatal(e)
	}
	if proxies.Load() != 0 || requests.Load() != 1 || supplied.Jar != jar || transport.Proxy == nil || client.client.Transport == transport {
		t.Fatalf("proxy/isolation contract failed proxies=%d requests=%d", proxies.Load(), requests.Load())
	}
	defaultClient, e := newNative(server.URL, nil, ClientOptions{})
	if e != nil {
		t.Fatal(e)
	}
	if defaultClient.client.Transport.(*http.Transport).Proxy != nil || http.DefaultTransport.(*http.Transport).Proxy == nil {
		t.Fatal("default transport mutated or ambient proxy retained")
	}
	var custom atomic.Int32
	round := nativeRoundTripper(func(r *http.Request) (*http.Response, error) {
		custom.Add(1)
		return http.DefaultTransport.RoundTrip(r)
	})
	injected, e := newNative(server.URL, nil, ClientOptions{HTTP: &http.Client{Transport: round}})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = injected.call(context.Background(), "/", "GET", nil, false); e != nil || custom.Load() != 1 {
		t.Fatalf("custom transport lost %v %d", e, custom.Load())
	}
}
