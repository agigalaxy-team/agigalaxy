// Package devicefixture prepares synthetic cryptographic identity and trust
// materials for isolated Go tests. It does not create an authenticated session.
package devicefixture

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

const Endpoint = "https://device.example.invalid"
const Now int64 = 2000000000

type Genesis struct {
	ID           string          `json:"id"`
	GenesisProof json.RawMessage `json:"genesisProof"`
}
type Fixture struct {
	Genesis        Genesis `json:"genesis"`
	DeviceID       string  `json:"deviceId"`
	PublicKeyPEM   string  `json:"publicKeyPem"`
	HubPublic      string  `json:"hubPublic"`
	OwnerPrivate   string  `json:"ownerPrivate"`
	HubPrivate     string  `json:"hubPrivate"`
	InstallationID string  `json:"installationId"`
	Directory      string  `json:"-"`
}

func New(t *testing.T, pool *pgxpool.Pool, dir string) Fixture {
	return NewEndpoint(t, pool, dir, Endpoint)
}

// NewEndpoint creates isolated synthetic identity material for the selected test endpoint.
func NewEndpoint(t *testing.T, pool *pgxpool.Pool, dir, endpoint string) Fixture {
	t.Helper()
	ctx := context.Background()
	if _, e := databaseschema.Migrate(ctx, pool, []string{"api"}); e != nil {
		t.Fatal(e)
	}
	ownerPublic, owner, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	hubPublic, hub, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	public, e := identity.PublicPEM(ownerPublic)
	if e != nil {
		t.Fatal(e)
	}
	hubPEM, e := identity.PublicPEM(hubPublic)
	if e != nil {
		t.Fatal(e)
	}
	privatePEM := func(key ed25519.PrivateKey) string {
		t.Helper()
		b, e := x509.MarshalPKCS8PrivateKey(key)
		if e != nil {
			t.Fatal(e)
		}
		return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: b}))
	}
	nonce := make([]byte, 32)
	if _, e = rand.Read(nonce); e != nil {
		t.Fatal(e)
	}
	ms := Now * 1000
	alphabet := "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	base32 := func(n *big.Int, count int) string {
		out := make([]byte, count)
		a := new(big.Int).Set(n)
		mask := big.NewInt(31)
		for i := count - 1; i >= 0; i-- {
			out[i] = alphabet[new(big.Int).And(a, mask).Int64()]
			a.Rsh(a, 5)
		}
		return string(out)
	}
	input := append([]byte(fmt.Sprintf("galaxy/guid/v1\x005\x00%d\x00%s\x00", ms, strings.TrimSpace(public))), nonce...)
	digest := sha256.Sum256(input)
	subject := "GUID15" + base32(big.NewInt(ms), 10) + base32(new(big.Int).SetBytes(digest[:10]), 16)
	proof, e := json.Marshal(map[string]any{"version": 1, "publicKeyPem": public, "nonce": base64.RawURLEncoding.EncodeToString(nonce)})
	if e != nil {
		t.Fatal(e)
	}
	if !identity.VerifyPortableGenesis(subject, proof) {
		t.Fatal("generated genesis is not accepted")
	}
	f := Fixture{Genesis: Genesis{subject, proof}, DeviceID: uuid.NewString(), PublicKeyPEM: public, HubPublic: hubPEM, OwnerPrivate: privatePEM(owner), HubPrivate: privatePEM(hub), InstallationID: uuid.NewString(), Directory: dir}
	pin := map[string]any{"kid": "fixture", "publicKeyPem": hubPEM, "notBefore": Now - 100, "notAfter": Now + 100000, "revoked": false}
	data := map[string]any{"version": 1, "endpoint": endpoint, "sequence": 1, "keys": []any{pin}}
	b64 := base64.RawURLEncoding.EncodeToString
	encode := func(v any) string {
		b, e := json.Marshal(v)
		if e != nil {
			t.Fatal(e)
		}
		return b64(b)
	}
	inputJWT := encode(map[string]any{"alg": "Ed25519", "typ": "galaxy-keyring+jwt", "kid": "fixture"}) + "." + encode(map[string]any{"data": data, "iss": endpoint, "aud": endpoint, "iat": Now, "nbf": Now, "exp": Now + 86400, "jti": uuid.NewString()})
	signed := inputJWT + "." + b64(ed25519.Sign(hub, []byte(inputJWT)))
	write := func(name string, b []byte) {
		t.Helper()
		if e := os.WriteFile(filepath.Join(dir, name), b, 0600); e != nil {
			t.Fatal(e)
		}
	}
	writeJSON := func(name string, v any) {
		t.Helper()
		b, e := json.Marshal(v)
		if e != nil {
			t.Fatal(e)
		}
		write(name, b)
	}
	writeJSON("root-pins.json", data)
	writeJSON("keyring.json", map[string]any{"signed": signed})
	writeJSON("fixture.json", f)
	write("hub-private.pem", []byte(f.HubPrivate))
	return f
}
