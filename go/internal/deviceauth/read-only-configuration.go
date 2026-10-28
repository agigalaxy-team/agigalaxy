package deviceauth

import (
	"context"
	"github.com/jackc/pgx/v5/pgxpool"
)

// LoadReadOnly uses the original root-pin/keyring verification and persisted
// anti-rollback trust history. It deliberately never reads a signing key or
// constructs a current issuer: the returned keyring contains public keys only.
func LoadReadOnly(ctx context.Context, pool *pgxpool.Pool, c Configuration) (*Service, error) {
	c.SigningKeyFile = ""
	c.SigningKeyID = ""
	return loadConfiguration(ctx, pool, c, true)
}
