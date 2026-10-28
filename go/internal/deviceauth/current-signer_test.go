package deviceauth

import (
	"context"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/jackc/pgx/v5"
)

type signerRow func(...any) error

func (r signerRow) Scan(out ...any) error { return r(out...) }

type signerTx struct {
	pgx.Tx
	head                        bool
	device                      *string
	epoch                       int64
	scopes                      []string
	subjectExists, deviceExists bool
	queries                     int
}

func (t *signerTx) QueryRow(_ context.Context, query string, args ...any) pgx.Row {
	t.queries++
	return signerRow(func(out ...any) error {
		switch {
		case strings.Contains(query, "galaxy_api_lock_subject_control"):
			if !t.subjectExists {
				return pgx.ErrNoRows
			}
			*(out[0].(*string)) = "synthetic-public"
			return nil
		case strings.Contains(query, "subject_control_heads"):
			if !t.head {
				return pgx.ErrNoRows
			}
			*(out[0].(*int64)) = t.epoch
			*(out[1].(*string)) = "chain-head"
			return nil
		case strings.Contains(query, "device_authorizations"):
			if !strings.Contains(query, "status='active'") || args[1] != t.epoch {
				return pgx.ErrNoRows
			}
			if !t.deviceExists {
				return pgx.ErrNoRows
			}
			if d := args[2].(*string); d != nil && (t.device == nil || *d != *t.device) {
				return pgx.ErrNoRows
			}
			if args[3] != "current-key" {
				return pgx.ErrNoRows
			}
			*(out[0].(*string)) = "current-public"
			*(out[1].(*string)) = "current-key"
			*(out[2].(**string)) = t.device
			*(out[3].(*int64)) = t.epoch
			*(out[4].(*[]string)) = t.scopes
			return nil
		default:
			panic("retained signer must not read request credentials or expiry")
		}
	})
}
func TestRetainedCurrentSignerKeepsCurrentControlBoundary(t *testing.T) {
	ctx := context.Background()
	s := &Service{}
	device, key := "device", "current-key"
	tx := &signerTx{head: true, epoch: 7, device: &device, scopes: []string{"consent"}, subjectExists: true, deviceExists: true}
	c, e := s.CurrentSignerWithin(ctx, tx, "subject", &device, &key, 7, "consent")
	if e != nil || c.PublicKey != "current-public" || c.Epoch != 7 || c.DeviceID == nil || *c.DeviceID != device || c.ChainHead == nil || len(c.CredentialScopes) != 0 || len(c.BindingScopes) != 0 || tx.queries != 3 {
		t.Fatalf("retained signer %v %v", c, e)
	}
	for _, change := range []func(){func() { tx.epoch = 8 }, func() { tx.scopes = []string{"binding"} }, func() { tx.deviceExists = false }, func() { other := "other"; tx.device = &other }} {
		tx.epoch = 7
		tx.scopes = []string{"consent"}
		tx.deviceExists = true
		tx.device = &device
		change()
		_, e = s.CurrentSignerWithin(ctx, tx, "subject", &device, &key, 7, "consent")
		if fault.Code(e) != "identity_control_stale" {
			t.Fatalf("stale signer accepted %v", e)
		}
	}
	tx.head = false
	tx.device = nil
	c, e = s.CurrentSignerWithin(ctx, tx, "subject", nil, nil, 0, "consent")
	if e != nil || c.PublicKey != "synthetic-public" || c.KeyID != identity.Digest([]byte("synthetic-public")) {
		t.Fatalf("legacy original signer %v", e)
	}
	_, e = s.CurrentSignerWithin(ctx, tx, "subject", nil, nil, 1, "consent")
	if fault.Code(e) != "identity_control_upgrade_required" {
		t.Fatalf("legacy epoch accepted %v", e)
	}
	tx.subjectExists = false
	_, e = s.CurrentSignerWithin(ctx, tx, "missing", nil, nil, 0, "consent")
	if fault.Code(e) != "access_denied" {
		t.Fatalf("missing subject accepted %v", e)
	}
}
