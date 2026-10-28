package deviceauth

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/coreos/go-oidc/v3/oidc"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// OAuthIntrospectionConfig references the existing authorization server. It
// neither issues tokens nor shares a resource token with downstream services.
type OAuthIntrospectionConfig struct {
	Issuer, Resource, ClientID, ClientSecret string
	AllowedClientIDs, AllowedOrigins         []string
	AllowLoopbackHTTP                        bool
	Now                                      func() time.Time
	Transport                                http.RoundTripper
}
type OAuthClaims struct {
	Issuer, Subject, ClientID, Resource string
	ExpiresAt                           int64
	Scopes                              []string
}
type OAuthIntrospection struct {
	configuration OAuthIntrospectionConfig
	metadata      map[string]any
	client        *http.Client
	introspection string
	allowed       map[string]bool
}

func oauthInvalid() error { return fault.New("invalid_token", 401) }
func oauthText(v string, max int) bool {
	if utf8.RuneCountInString(v) < 1 || utf8.RuneCountInString(v) > max {
		return false
	}
	for _, r := range v {
		if unicode.Is(unicode.Cc, r) {
			return false
		}
	}
	return true
}
func oauthEndpoint(value string, loopback bool) (*url.URL, error) {
	u, e := url.Parse(value)
	if e != nil || u.Hostname() == "" || u.User != nil || u.Fragment != "" || u.RawQuery != "" || u.Scheme != "https" && !(loopback && u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")) {
		return nil, fault.New("oauth_configuration_invalid", 400)
	}
	return u, nil
}

type oauthTransport struct {
	next    http.RoundTripper
	origins map[string]bool
}

func (t oauthTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.User != nil || r.URL.Fragment != "" || !t.origins[r.URL.Scheme+"://"+r.URL.Host] {
		return nil, fault.New("oauth_introspection_unavailable", 503)
	}
	response, e := t.next.RoundTrip(r)
	if e != nil {
		return nil, e
	}
	raw, e := io.ReadAll(io.LimitReader(response.Body, 262145))
	_ = response.Body.Close()
	if e != nil || len(raw) > 262144 {
		return nil, fault.New("oauth_introspection_unavailable", 503)
	}
	response.Body = io.NopCloser(bytes.NewReader(raw))
	return response, nil
}
func NewOAuthIntrospection(ctx context.Context, c OAuthIntrospectionConfig) (*OAuthIntrospection, error) {
	authority, e := oauthEndpoint(c.Issuer, c.AllowLoopbackHTTP)
	if e != nil {
		return nil, e
	}
	if _, e = oauthEndpoint(c.Resource, c.AllowLoopbackHTTP); e != nil {
		return nil, e
	}
	if !oauthText(c.ClientID, 200) || !oauthText(c.ClientSecret, 4096) || len(c.AllowedClientIDs) < 1 || len(c.AllowedClientIDs) > 64 || len(c.AllowedOrigins) > 8 {
		return nil, fault.New("oauth_configuration_invalid", 400)
	}
	allowed := map[string]bool{}
	for _, v := range c.AllowedClientIDs {
		if !oauthText(v, 200) {
			return nil, fault.New("oauth_configuration_invalid", 400)
		}
		allowed[v] = true
	}
	origins := map[string]bool{authority.Scheme + "://" + authority.Host: true}
	for _, v := range c.AllowedOrigins {
		u, e := oauthEndpoint(v, c.AllowLoopbackHTTP)
		if e != nil || u.Scheme+"://"+u.Host != v {
			return nil, fault.New("oauth_configuration_invalid", 400)
		}
		origins[v] = true
	}
	next := c.Transport
	if next == nil {
		next = http.DefaultTransport
	}
	client := &http.Client{Timeout: 5 * time.Second, Transport: oauthTransport{next, origins}, CheckRedirect: func(*http.Request, []*http.Request) error { return fault.New("oauth_introspection_unavailable", 503) }}
	provider, e := oidc.NewProvider(oidc.ClientContext(ctx, client), c.Issuer)
	if e != nil {
		return nil, fault.New("oauth_discovery_unavailable", 503)
	}
	var metadata map[string]any
	if provider.Claims(&metadata) != nil || metadata["issuer"] != c.Issuer {
		return nil, fault.New("oauth_discovery_unavailable", 503)
	}
	methods, _ := metadata["code_challenge_methods_supported"].([]any)
	s256 := false
	for _, v := range methods {
		s256 = s256 || v == "S256"
	}
	if !s256 {
		return nil, fault.New("oauth_discovery_unavailable", 503)
	}
	for _, field := range []string{"authorization_endpoint", "token_endpoint", "introspection_endpoint"} {
		v, _ := metadata[field].(string)
		u, e := oauthEndpoint(v, c.AllowLoopbackHTTP)
		if e != nil || !origins[u.Scheme+"://"+u.Host] {
			return nil, fault.New("oauth_discovery_unavailable", 503)
		}
	}
	c.AllowedClientIDs = append([]string{}, c.AllowedClientIDs...)
	c.AllowedOrigins = append([]string{}, c.AllowedOrigins...)
	endpoint, _ := metadata["introspection_endpoint"].(string)
	return &OAuthIntrospection{configuration: c, metadata: metadata, client: client, introspection: endpoint, allowed: allowed}, nil
}
func (v *OAuthIntrospection) Resource() string {
	if v == nil {
		return ""
	}
	return v.configuration.Resource
}
func (v *OAuthIntrospection) Metadata() map[string]any {
	if v == nil {
		return nil
	}
	raw, _ := json.Marshal(v.metadata)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return out
}
func (v *OAuthIntrospection) now() int64 {
	if v.configuration.Now != nil {
		return v.configuration.Now().Unix()
	}
	return time.Now().Unix()
}

var oauthScopePattern = regexp.MustCompile(`^[\x21\x23-\x5b\x5d-\x7e]{1,100}$`)

// formUrlEncode is the original OAuth HTTP Basic component encoding.
func oauthForm(v string) string {
	return strings.NewReplacer("-", "%2D", "_", "%5F", ".", "%2E", "~", "%7E").Replace(url.QueryEscape(v))
}
func (v *OAuthIntrospection) Verify(ctx context.Context, token string) (OAuthClaims, error) {
	if v == nil {
		return OAuthClaims{}, fault.New("oauth_introspection_unavailable", 503)
	}
	if len(token) < 1 || len(token) > 16384 {
		return OAuthClaims{}, oauthInvalid()
	}
	for _, b := range []byte(token) {
		if b < 0x21 || b > 0x7e {
			return OAuthClaims{}, oauthInvalid()
		}
	}
	body := url.Values{"token": {token}, "token_type_hint": {"access_token"}}.Encode()
	request, e := http.NewRequestWithContext(ctx, "POST", v.introspection, strings.NewReader(body))
	if e != nil {
		return OAuthClaims{}, fault.New("oauth_introspection_unavailable", 503)
	}
	request.GetBody = nil
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(oauthForm(v.configuration.ClientID)+":"+oauthForm(v.configuration.ClientSecret))))
	response, e := v.client.Do(request)
	if e != nil {
		return OAuthClaims{}, fault.New("oauth_introspection_unavailable", 503)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return OAuthClaims{}, fault.New("oauth_introspection_unavailable", 503)
	}
	media := strings.ToLower(strings.TrimSpace(strings.SplitN(response.Header.Get("Content-Type"), ";", 2)[0]))
	var raw map[string]any
	if media == "application/token-introspection+jwt" {
		b, e := io.ReadAll(response.Body)
		if e != nil {
			return OAuthClaims{}, fault.New("oauth_introspection_unavailable", 503)
		}
		raw, e = v.responseJWT(string(b))
		if e != nil {
			return OAuthClaims{}, e
		}
	} else if media == "application/json" {
		decoder := json.NewDecoder(response.Body)
		decoder.UseNumber()
		if decoder.Decode(&raw) != nil {
			return OAuthClaims{}, fault.New("oauth_introspection_unavailable", 503)
		}
		var tail any
		if decoder.Decode(&tail) != io.EOF {
			return OAuthClaims{}, fault.New("oauth_introspection_unavailable", 503)
		}
	} else {
		return OAuthClaims{}, fault.New("oauth_introspection_unavailable", 503)
	}
	if _, ok := raw["active"].(bool); !ok {
		return OAuthClaims{}, fault.New("oauth_introspection_unavailable", 503)
	}

	return v.claims(raw)
}
func (v *OAuthIntrospection) claims(raw map[string]any) (OAuthClaims, error) {
	if raw["active"] != true {
		return OAuthClaims{}, oauthInvalid()
	}
	subject, subOK := raw["sub"].(string)
	client, clientOK := raw["client_id"].(string)
	scope, scopeOK := raw["scope"].(string)
	exp, ok := raw["exp"].(json.Number)
	if !subOK || !clientOK || !scopeOK || !oauthText(subject, 255) || !oauthText(client, 200) || utf8.RuneCountInString(scope) < 1 || utf8.RuneCountInString(scope) > 4096 || !ok {
		return OAuthClaims{}, oauthInvalid()
	}
	expiry, e := exp.Float64()
	if e != nil || expiry <= 0 || expiry > 9007199254740991 || expiry != float64(int64(expiry)) || expiry <= float64(v.now()) {
		return OAuthClaims{}, oauthInvalid()
	}
	if iss, exists := raw["iss"]; exists {
		if s, ok := iss.(string); !ok || s != v.configuration.Issuer {
			return OAuthClaims{}, oauthInvalid()
		}
	}
	if typ, exists := raw["token_type"]; exists {
		if s, ok := typ.(string); !ok || strings.ToLower(s) != "bearer" {
			return OAuthClaims{}, oauthInvalid()
		}
	}
	audiences := []string{}
	switch aud := raw["aud"].(type) {
	case string:
		audiences = append(audiences, aud)
	case []any:
		if len(aud) < 1 || len(aud) > 8 {
			return OAuthClaims{}, oauthInvalid()
		}
		for _, a := range aud {
			s, ok := a.(string)
			if !ok {
				return OAuthClaims{}, oauthInvalid()
			}
			audiences = append(audiences, s)
		}
	default:
		return OAuthClaims{}, oauthInvalid()
	}
	if !contains(audiences, v.configuration.Resource) || !v.allowed[client] {
		return OAuthClaims{}, oauthInvalid()
	}
	scopes := strings.Split(scope, " ")
	if len(scopes) > 64 {
		return OAuthClaims{}, oauthInvalid()
	}
	seen := map[string]bool{}
	for _, s := range scopes {
		if !oauthScopePattern.MatchString(s) || seen[s] {
			return OAuthClaims{}, oauthInvalid()
		}
		seen[s] = true
	}
	return OAuthClaims{Issuer: v.configuration.Issuer, Subject: subject, ClientID: client, Resource: v.configuration.Resource, ExpiresAt: int64(expiry), Scopes: scopes}, nil
}

// responseJWT interprets only the response from the freshly authenticated AS
// transport. As in the original default openid-client configuration, this is
// a response container, not independent proof and never a submitted token.
func (v *OAuthIntrospection) responseJWT(value string) (map[string]any, error) {
	unavailable := func() (map[string]any, error) { return nil, fault.New("oauth_introspection_unavailable", 503) }
	parts := strings.Split(value, ".")
	if len(parts) != 3 {
		return unavailable()
	}
	decode := func(s string) (map[string]any, error) {
		b, e := base64.RawURLEncoding.DecodeString(s)
		if e != nil {
			return nil, e
		}
		d := json.NewDecoder(bytes.NewReader(b))
		d.UseNumber()
		var o map[string]any
		if e = d.Decode(&o); e != nil || o == nil {
			return nil, oauthInvalid()
		}
		var tail any
		if d.Decode(&tail) != io.EOF {
			return nil, oauthInvalid()
		}
		return o, nil
	}
	header, e := decode(parts[0])
	if e != nil {
		return unavailable()
	}
	if _, exists := header["crit"]; exists {
		return unavailable()
	}
	typ, ok := header["typ"].(string)
	if !ok || strings.TrimPrefix(strings.ToLower(typ), "application/") != "token-introspection+jwt" {
		return unavailable()
	}
	alg, ok := header["alg"].(string)
	if !ok {
		return unavailable()
	}
	supported := []string{"RS256"}
	if rows, ok := v.metadata["introspection_signing_alg_values_supported"].([]any); ok {
		supported = []string{}
		for _, row := range rows {
			if s, ok := row.(string); ok {
				supported = append(supported, s)
			}
		}
	}
	if !contains(supported, alg) {
		return unavailable()
	}
	claims, e := decode(parts[1])
	if e != nil || claims["iss"] != v.configuration.Issuer {
		return unavailable()
	}
	if _, ok := claims["iat"].(json.Number); !ok {
		return unavailable()
	}
	audience := false
	switch aud := claims["aud"].(type) {
	case string:
		audience = aud == v.configuration.ClientID
	case []any:
		for _, item := range aud {
			client, ok := item.(string)
			if !ok {
				return unavailable()
			}
			audience = audience || client == v.configuration.ClientID
		}
	default:
		return unavailable()
	}
	if !audience {
		return unavailable()
	}
	for _, name := range []string{"exp", "nbf"} {
		if n, exists := claims[name]; exists {
			number, ok := n.(json.Number)
			if !ok {
				return unavailable()
			}
			f, e := number.Float64()
			if e != nil || name == "exp" && f <= float64(v.now()-30) || name == "nbf" && f > float64(v.now()+30) {
				return unavailable()
			}
		}
	}
	raw, ok := claims["token_introspection"].(map[string]any)
	if !ok || raw == nil {
		return unavailable()
	}
	return raw, nil
}
