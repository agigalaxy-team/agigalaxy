package postgres

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Open does not run migrations or change server configuration.
func Open(ctx context.Context, connection string) (*pgxpool.Pool, error) {
	c, err := pgxpool.ParseConfig(connection)
	if err != nil {
		return nil, err
	}
	c.ConnConfig.ConnectTimeout = 10 * time.Second
	c.ConnConfig.RuntimeParams["application_name"] = "galaxy-go"
	c.ConnConfig.RuntimeParams["statement_timeout"] = "10000"
	p, err := pgxpool.NewWithConfig(ctx, c)
	if err != nil {
		return nil, err
	}
	if err = p.Ping(ctx); err != nil {
		p.Close()
		return nil, err
	}
	return p, nil
}

// InTx never retries a callback: after a transport error its writes may already
// have committed. Recovery belongs to the original business operation receipt.
func InTx[T any](ctx context.Context, pool *pgxpool.Pool, fn func(pgx.Tx) (T, error)) (out T, err error) {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return out, err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	out, err = fn(tx)
	if err != nil {
		return out, err
	}
	err = tx.Commit(ctx)
	return out, err
}
