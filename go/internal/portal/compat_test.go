package portal

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/feedbackfixture"
	"github.com/jackc/pgx/v5"
)

type providerFunc func(context.Context, RefreshRequest) (Tokens, error)

func (f providerFunc) Refresh(ctx context.Context, r RefreshRequest) (Tokens, error) {
	return f(ctx, r)
}

// The original Node AES-GCM output is a fixed synthetic vector captured once.
func TestCapturedPortalCipherAndGoWireFormat(t *testing.T) {
	dir := t.TempDir()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	keyPath := filepath.Join(dir, "portal-key")
	if e := os.WriteFile(keyPath, []byte(base64.RawURLEncoding.EncodeToString(key)), 0600); e != nil {
		t.Fatal(e)
	}
	policy, e := LoadPolicy(keyPath, 604800, 2592000, 60)
	if e != nil {
		t.Fatal(e)
	}
	hash, scope := strings.Repeat("b", 64), []string{strings.Repeat("a", 64)}
	sessions, e := New(nil, "account", scope, policy, nil)
	if e != nil {
		t.Fatal(e)
	}
	const captured = "JOeedWfADezSy6lVngSr0jNFVerlVcE2wfRb-Jhb5WmX3cCa641x6V_MNSWi1Z_MavDi9DbRmKNLLkU"
	plain, e := sessions.Decrypt(captured, hash)
	if e != nil || plain != "temporary-fixture-refresh-token" {
		t.Fatalf("captured cipher: %v", e)
	}
	if _, e = sessions.Decrypt(captured, strings.Repeat("c", 64)); e == nil {
		t.Fatal("different owner context decrypted")
	}
	wire, e := sessions.Encrypt("go-fixture-rotated-token", hash)
	if e != nil {
		t.Fatal(e)
	}
	raw, e := base64.RawURLEncoding.DecodeString(wire)
	if e != nil {
		t.Fatal(e)
	}
	block, e := aes.NewCipher(key)
	if e != nil {
		t.Fatal(e)
	}
	gcm, e := cipher.NewGCM(block)
	if e != nil {
		t.Fatal(e)
	}
	aad, e := json.Marshal([]string{"account", scope[0], hash})
	if e != nil {
		t.Fatal(e)
	}
	decoded, e := gcm.Open(nil, raw[:gcm.NonceSize()], raw[gcm.NonceSize():], aad)
	if e != nil || string(decoded) != "go-fixture-rotated-token" {
		t.Fatalf("cipher wire format: %v", e)
	}
}
func TestCurrentPortalRowsRefreshOnceAndKeepUnknownAndRevocation(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	seeded := feedbackfixture.Create(t, pool)
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
