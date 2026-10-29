package access

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/accessfixture"
	"testing"
)

func TestOriginalConfigurationScopeBytesArePreserved(t *testing.T) {
	original := accessfixture.Create(t, t.TempDir(), "https://api.example.invalid", "https://web.example.invalid", "https://admin.example.invalid")
	g, e := Load(context.Background(), nil, original.Endpoint, original.AccountFile, original.OperationsFile, original.IdentityFile)
	if e != nil {
		t.Fatal(e)
	}
	if g.Config.AccountScope != "89573059e7d62fbbc3668ac499b52e71c6a5de0cd225d31c8b3af79b6e5353a0" || g.Config.OperatorConfiguration != "ffca50ef560a1e31b6e99938d12f18cf354c5bc196fd7d71acffb65d19e66a62" || g.Config.Root.OperatorID != original.RootID || original.RootID != "54e02b20ce8dd3db2dd5b50e969b2fa393900b2e6c37d6ba1dcff62e5a7985c6" {
		t.Fatal("configuration changed existing account/operator session scope")
	}
	if g.Config.AccountIssuer == g.Config.OperatorIssuer {
		t.Fatal("management and public account authentication collapsed")
	}
}
