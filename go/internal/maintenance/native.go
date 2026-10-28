// Package maintenance owns the existing protected Unix-socket request boundary.
// Domain command schemas remain with their respective maintenance/settings owner.
package maintenance

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
)

type Configuration struct{ SocketPath, Key string }
type Options struct {
	Now       func() time.Time
	Transport http.RoundTripper
}
type Client struct {
	configuration Configuration
	now           func() time.Time
	client        *http.Client
}
type VerifiedService struct {
	owner             *Client
	id, at, signature string
}

var socketPattern = regexp.MustCompile(`^/run/galaxy-maintenance/[a-z0-9-]+[.]sock$`)
var idPattern = regexp.MustCompile(`^[a-f0-9-]{36}$`)
var atPattern = regexp.MustCompile(`^\d{1,12}$`)
var signaturePattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func unavailable() error { return fault.New("maintenance_native_unavailable", 503) }
func protected(path string, max int64) ([]byte, error) {
	if !filepath.IsAbs(path) {
		return nil, unavailable()
	}
	before, e := os.Lstat(path)
	if e != nil || !before.Mode().IsRegular() || before.Mode().Perm()&0027 != 0 || before.Size() > max {
		return nil, unavailable()
	}
	sys := reflect.ValueOf(before.Sys())
	if sys.Kind() == reflect.Pointer {
		sys = sys.Elem()
	}
	if !sys.IsValid() || sys.Kind() != reflect.Struct {
		return nil, unavailable()
	}
	uid := sys.FieldByName("Uid")
	if !uid.IsValid() || !uid.CanUint() || uid.Uint() != 0 {
		return nil, unavailable()
	}
	f, e := os.Open(path)
	if e != nil {
		return nil, unavailable()
	}
	defer f.Close()
	opened, e := f.Stat()
	if e != nil || !os.SameFile(before, opened) {
		return nil, unavailable()
	}
	b, e := io.ReadAll(io.LimitReader(f, max+1))
	if e != nil || int64(len(b)) > max {
		return nil, unavailable()
	}
	after, e := f.Stat()
	if e != nil || after.Size() != int64(len(b)) || !after.ModTime().Equal(opened.ModTime()) {
		return nil, unavailable()
	}
	return b, nil
}
func Load(file string) (*Configuration, error) {
	if file == "" {
		return nil, nil
	}
	return load(file, protected)
}
func load(file string, read func(string, int64) ([]byte, error)) (*Configuration, error) {
	b, e := read(file, 16384)
	if e != nil {
		return nil, e
	}
	var v struct {
		Version json.Number `json:"version"`
		Socket  string      `json:"socketPath"`
		KeyFile string      `json:"keyFile"`
	}
	if protocol.Decode(b, &v) != nil {
		return nil, unavailable()
	}
	version, err := v.Version.Float64()
	if err != nil || version != 1 || !socketPattern.MatchString(v.Socket) || !filepath.IsAbs(v.KeyFile) {
		return nil, unavailable()
	}
	b, e = read(v.KeyFile, 2048)
	if e != nil {
		return nil, e
	}
	key := strings.Trim(string(b), "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
	if protocol.TextLength(key) < 32 || protocol.TextLength(key) > 1024 || strings.ContainsFunc(key, func(r rune) bool { return unicode.IsControl(r) || unicode.IsSpace(r) || r == '\ufeff' }) {
		return nil, unavailable()
	}
	return &Configuration{SocketPath: v.Socket, Key: key}, nil
}
func New(c Configuration, o Options) *Client {
	now := o.Now
	if now == nil {
		now = time.Now
	}
	transport := o.Transport
	if transport == nil {
		transport = &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", c.SocketPath)
		}}
	}
	return &Client{configuration: c, now: now, client: &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return unavailable() }}}
}
func Signature(key, id, at string, body []byte) string {
	h := hmac.New(sha256.New, []byte(key))
	h.Write([]byte(id + "\n" + at + "\n"))
	h.Write(body)
	return hex.EncodeToString(h.Sum(nil))
}
func KeyMatches(expected, received string) bool {
	if protocol.TextLength(expected) < 32 || protocol.TextLength(received) > 1024 {
		return false
	}
	a, b := sha256.Sum256([]byte(expected)), sha256.Sum256([]byte(received))
	return subtle.ConstantTimeCompare(a[:], b[:]) == 1
}
func (c *Client) VerifyService(r *http.Request) (*VerifiedService, error) {
	if c == nil || c.configuration.Key == "" {
		return nil, fault.New("maintenance_native_not_configured", 503)
	}
	for _, k := range []string{"X-Galaxy-Service-Key", "X-Galaxy-Request-Id", "X-Galaxy-Request-At", "X-Galaxy-Service-Signature"} {
		if len(r.Header.Values(k)) != 1 {
			return nil, fault.New("maintenance_service_denied", 401)
		}
	}
	id, at, signature := r.Header.Get("X-Galaxy-Request-Id"), r.Header.Get("X-Galaxy-Request-At"), r.Header.Get("X-Galaxy-Service-Signature")
	n, e := strconv.ParseInt(at, 10, 64)
	delta := c.now().Unix() - n
	if !KeyMatches(c.configuration.Key, r.Header.Get("X-Galaxy-Service-Key")) || !idPattern.MatchString(id) || !atPattern.MatchString(at) || e != nil || delta < -30 || delta > 30 || !signaturePattern.MatchString(signature) {
		return nil, fault.New("maintenance_service_denied", 401)
	}
	return &VerifiedService{owner: c, id: id, at: at, signature: signature}, nil
}
func (c *Client) VerifyBody(v *VerifiedService, body []byte) error {
	if v == nil || v.owner != c || len(body) > 65536 || !hmac.Equal([]byte(v.signature), []byte(Signature(c.configuration.Key, v.id, v.at, body))) {
		return fault.New("maintenance_service_denied", 401)
	}
	return nil
}
func (c *Client) call(ctx context.Context, path string, body []byte, limit int64, timeout time.Duration) (json.RawMessage, int, error) {
	if c == nil || c.configuration.SocketPath == "" || c.configuration.Key == "" {
		return nil, 0, fault.New("maintenance_native_not_configured", 503)
	}
	id, at := uuid.NewString(), strconv.FormatInt(c.now().Unix(), 10)
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, "POST", "http://localhost"+path, bytes.NewReader(body))
	if e != nil {
		return nil, 0, unavailable()
	}
	req.GetBody = nil
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Galaxy-Service-Key", c.configuration.Key)
	req.Header.Set("X-Galaxy-Request-Id", id)
	req.Header.Set("X-Galaxy-Request-At", at)
	req.Header.Set("X-Galaxy-Service-Signature", Signature(c.configuration.Key, id, at, body))
	res, e := c.client.Do(req)
	if e != nil {
		return nil, 0, unavailable()
	}
	defer res.Body.Close()
	raw, e := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if e != nil || int64(len(raw)) > limit || !json.Valid(raw) {
		return nil, 0, unavailable()
	}
	return raw, res.StatusCode, nil
}
func (c *Client) SystemSettings(ctx context.Context, body []byte) (json.RawMessage, int, error) {
	if len(body) > 65536 {
		return nil, 0, fault.New("invalid_system_settings_request", 400)
	}
	return c.call(ctx, "/v1/system-settings", body, 1048576, 20*time.Second)
}
