package accountlinks

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
)

func TestMappingLockKeysMatchOriginalJS(t *testing.T) {
	endpoint := "https://device.example.invalid"
	subjects := []string{"GUID-synthetic-one", "GUID-synthetic-two", "GUID-synthetic-one"}
	original := []int32{-1759405157, 158562617}
	keys, e := MappingLockKeys(endpoint, subjects)
	if e != nil || !reflect.DeepEqual(keys, original) {
		t.Fatalf("mapping physical lock contract %v %v %v", keys, original, e)
	}
}
func TestMappingReadFenceBlocksOriginalExclusiveWriter(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	read, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer read.Rollback(ctx)
	subject := "GUID-controlled-owner"
	endpoint := "https://device.example.invalid"
	if e = LockMappingsWithin(ctx, read, endpoint, []string{subject}, false); e != nil {
		t.Fatal(e)
	}
	writer, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	keys, _ := MappingLockKeys(endpoint, []string{subject})
	var available bool
	if e = writer.QueryRow(ctx, "SELECT pg_try_advisory_xact_lock($1,$2)", int32(0x47434d31), keys[0]).Scan(&available); e != nil || available {
		t.Fatal("mapping writer crossed active qualification read fence")
	}
	writer.Rollback(ctx)
	read.Commit(ctx)
	writer, e = pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer writer.Rollback(ctx)
	if e = writer.QueryRow(ctx, "SELECT pg_try_advisory_xact_lock($1,$2)", int32(0x47434d31), keys[0]).Scan(&available); e != nil || !available {
		t.Fatal("qualification read leaked its transaction mapping fence")
	}
}
func TestProviderMetadataRejectsMissingOrNullConfiguration(t *testing.T) {
	for _, raw := range []string{`{}`, `{"version":1}`, `{"version":1,"providers":null}`, `{"version":1,"providers":[{"id":"fixture","name":"fixture","issuer":"https://issuer.invalid","clientId":"fixture","allowedOrigins":null}]}`, `{"version":1,"providers":[{"id":"fixture","name":"fixture","issuer":"https://issuer.invalid","clientId":"fixture","clientSecretEnv":""}]}`} {
		path := filepath.Join(t.TempDir(), "identity.json")
		os.WriteFile(path, []byte(raw), 0600)
		if _, e := LoadProviders(context.Background(), nil, "https://device.example.invalid", path, func(string) string { return "" }); e == nil {
			t.Fatalf("invalid original identity metadata accepted: %s", raw)
		}
	}
}
