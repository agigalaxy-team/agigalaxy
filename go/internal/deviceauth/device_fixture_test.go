package deviceauth

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/devicefixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"path/filepath"
	"testing"
	"time"
)

func prepareControlFixture(t *testing.T, pool *pgxpool.Pool, dir string, bootstrap bool) devicefixture.Fixture {
	t.Helper()
	f := devicefixture.New(t, pool, dir)
	if !bootstrap {
		return f
	}
	ctx := context.Background()
	svc, e := Load(ctx, pool, Configuration{Endpoint: devicefixture.Endpoint, SigningKeyFile: filepath.Join(dir, "hub-private.pem"), SigningKeyID: "fixture", RootPinsFile: filepath.Join(dir, "root-pins.json"), KeyringFile: filepath.Join(dir, "keyring.json"), TrustDirectory: filepath.Join(dir, "trust"), Now: func() time.Time { return time.Unix(devicefixture.Now, 0) }})
	if e != nil {
		t.Fatal(e)
	}
	key, e := identity.PrivatePEM([]byte(f.OwnerPrivate))
	if e != nil {
		t.Fatal(e)
	}
	request := ControlRequest{Version: 2, OperationID: uuid.NewString(), SubjectID: f.Genesis.ID, Kind: "bootstrap", SignerKeyID: identity.Digest([]byte(f.PublicKeyPEM)), GenesisProof: f.Genesis.GenesisProof, NewDevice: &ControlDevice{DeviceID: f.DeviceID, PublicKeyPEM: f.PublicKeyPEM, Scopes: []string{"manage-identity", "binding", "history"}}}
	raw, e := json.Marshal(request)
	if e != nil {
		t.Fatal(e)
	}
	challenge, e := svc.ControlChallenge(ctx, raw)
	if e != nil {
		t.Fatal(e)
	}
	signature, e := identity.SignIdentityPayload(key, challenge["challenge"].(string), "galaxy-identity-control-v2+jws")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = svc.ControlCommit(ctx, ControlCommit{OperationID: request.OperationID, ControllerSignature: signature, NewDeviceProof: &signature}); e != nil {
		t.Fatal(e)
	}
	return f
}
