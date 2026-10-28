package portal

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5"
)

type providerFunc func(context.Context, RefreshRequest) (Tokens, error)

func (f providerFunc) Refresh(ctx context.Context, r RefreshRequest) (Tokens, error) {
	return f(ctx, r)
}
func node(t *testing.T, dsn, name string, args ...string) []byte {
	t.Helper()
	root, e := filepath.Abs(filepath.Join("..", "..", ".."))
	if e != nil {
		t.Fatal(e)
	}
	cmd := exec.Command("node", append([]string{filepath.Join(root, "scripts", "go", name)}, args...)...)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	out, e := cmd.Output()
	if e != nil {
		var detail string
		if x, ok := e.(*exec.ExitError); ok {
			detail = string(x.Stderr)
		}
		t.Fatalf("original portal fixture: %v %s", e, detail)
	}
	return out
}
func TestExistingNodeCipherAndGoCipherAreInteroperable(t *testing.T) {
	dir := t.TempDir()
	var original struct {
		KeyPath, Hash, Token, Cipher string
		Scope                        []string
	}
	if e := json.Unmarshal(node(t, "", "portal-fixture.mjs", dir, "create"), &original); e != nil {
		t.Fatal(e)
	}
	p, e := LoadPolicy(original.KeyPath, 604800, 2592000, 60)
	if e != nil {
		t.Fatal(e)
	}
	s, e := New(nil, "account", original.Scope, p, nil)
	if e != nil {
		t.Fatal(e)
	}
	plain, e := s.Decrypt(original.Cipher, original.Hash)
	if e != nil || plain != original.Token {
		t.Fatalf("Node ciphertext not readable: %v", e)
	}
	if _, e = s.Decrypt(original.Cipher, strings.Repeat("c", 64)); e == nil {
		t.Fatal("different owner context decrypted")
	}
	b, e := s.Encrypt("go-fixture-rotated-token", original.Hash)
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(dir, "go-cipher"), []byte(b), 0600); e != nil {
		t.Fatal(e)
	}
	var read struct{ Token string }
	if e = json.Unmarshal(node(t, "", "portal-fixture.mjs", dir, "decrypt"), &read); e != nil || read.Token != "go-fixture-rotated-token" {
		t.Fatalf("Go ciphertext not readable by Node: %v", e)
	}
}
func TestCurrentPortalRowsRefreshOnceAndKeepUnknownAndRevocation(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	var seeded struct {
		Accounts []string
		Endpoint string
	}
	if e := json.Unmarshal(node(t, dsn, "feedback-fixture.mjs", "setup"), &seeded); e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	now := int64(2000000000)
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	p := Policy{key, 604800, 2592000, 60}
	hash, scope := strings.Repeat("b", 64), []string{strings.Repeat("a", 64)}
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	provider := providerFunc(func(_ context.Context, r RefreshRequest) (Tokens, error) {
		if calls.Add(1) == 1 {
			close(entered)
		}
		<-release
		if r.Token != "original-test-token" || r.Subject != seeded.Accounts[0] {
			return Tokens{}, errors.New("unexpected refresh context")
		}
		return Tokens{"next-test-token", now + 600}, nil
	})
	s, e := New(pool, "account", scope, p, provider)
	if e != nil {
		t.Fatal(e)
	}
	s.Now = func() time.Time { return time.Unix(now, 0) }
	cipher, e := s.Encrypt("original-test-token", hash)
	if e != nil {
		t.Fatal(e)
	}
	_, e = pool.Exec(ctx, `INSERT INTO official_account_sessions_v1(scope_hash,token_hash,login_hash,account_id,issuer,external_subject,email,email_verified,csrf_token,created_at,expires_at,
	 refresh_cipher,upstream_expires_at,idle_expires_at,max_expires_at)
	 VALUES($1,$2,$3,$4,'https://login.example.invalid',$5,'fixture@example.invalid',true,$6,$7,$8,$9,$10,$11,$12)`, scope[0], hash, strings.Repeat("d", 64), seeded.Accounts[0], seeded.Accounts[0], strings.Repeat("x", 43), now, now+3600, cipher, now+10, now+1000, now+2592000)
	if e != nil {
		t.Fatal(e)
	}
	row, e := s.Read(ctx, hash)
	if e != nil {
		t.Fatal(e)
	}
	type answer struct {
		v Live
		e error
	}
	done := make(chan answer, 1)
	go func() { v, e := s.Current(ctx, row, true); done <- answer{v, e} }()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if _, e = s.Current(ctx, row, false); fault.Code(e) != "portal_session_refresh_unconfirmed" {
		t.Fatalf("second claimant: %v", e)
	}
	close(release)
	result := <-done
	if result.e != nil || !result.v.Active || result.v.ExpiresAt != now+p.IdleSeconds {
		t.Fatalf("refresh result %v %v", result.v, result.e)
	}
	if calls.Load() != 1 {
		t.Fatal("refresh exchanged twice")
	}
	row, e = s.Read(ctx, hash)
	if e != nil {
		t.Fatal(e)
	}
	if row.Version != 1 || row.RefreshState != "ready" {
		t.Fatal("refresh receipt missing")
	}
	token, e := s.Decrypt(row.RefreshCipher, hash)
	if e != nil || token != "next-test-token" {
		t.Fatal("rotated refresh token not retained")
	}
	// A lost provider response remains unknown and cannot consume the same token again.
	_, e = pool.Exec(ctx, "UPDATE official_account_sessions_v1 SET upstream_expires_at=$3 WHERE scope_hash=$1 AND token_hash=$2", scope[0], hash, now)
	if e != nil {
		t.Fatal(e)
	}
	s.Provider = providerFunc(func(context.Context, RefreshRequest) (Tokens, error) {
		calls.Add(1)
		return Tokens{}, errors.New("temporary transport loss")
	})
	row, _ = s.Read(ctx, hash)
	_, e = s.Current(ctx, row, false)
	if fault.Code(e) != "portal_session_refresh_unconfirmed" {
		t.Fatal(e)
	}
	row, _ = s.Read(ctx, hash)
	if row.RefreshState != "unknown" {
		t.Fatal("unknown response was not retained")
	}
	_, e = s.Current(ctx, row, false)
	if fault.Code(e) != "portal_session_refresh_unconfirmed" || calls.Load() != 2 {
		t.Fatal("unknown refresh replayed")
	}
	// The only next exchange here uses a newly installed controlled test token,
	// not a production recovery or retry of the unknown token above.
	_, e = pool.Exec(ctx, "UPDATE official_account_sessions_v1 SET refresh_state='ready',refresh_cipher=$3,refresh_version=refresh_version+1 WHERE scope_hash=$1 AND token_hash=$2", scope[0], hash, cipher)
	if e != nil {
		t.Fatal(e)
	}
	s.Provider = providerFunc(func(context.Context, RefreshRequest) (Tokens, error) {
		return Tokens{}, fault.New("portal_refresh_rejected", 401)
	})
	row, _ = s.Read(ctx, hash)
	v, e := s.Current(ctx, row, false)
	if e != nil || v.Active {
		t.Fatalf("rejected refresh not revoked %v %v", v, e)
	}
	if _, e = s.Read(ctx, hash); !errors.Is(e, pgx.ErrNoRows) {
		t.Fatalf("revoked session remains readable: %v", e)
	}
}
