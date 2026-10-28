// Independent public-content activation process. It consumes only explicitly
// adopted content-publication jobs; Payload and Next retain their own runtimes.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publication"
	"github.com/agigalaxy-team/agigalaxy/go/internal/runtimeconfig"
)

func run(ctx context.Context) error {
	if _, err := runtimeconfig.RuntimeServiceRelease(os.Getenv, "publisher", ""); err != nil {
		return err
	}
	if os.Geteuid() == 0 {
		return fault.New("non_root_runtime_required", 400)
	}
	config, e := publication.LoadConfiguration(os.Getenv("GALAXY_CONTENT_PUBLISHER_CONFIG_FILE"))
	if e != nil {
		return e
	}
	if os.Getenv("DATABASE_URL") == "" {
		return fault.New("site_publication_configuration_invalid", 400)
	}
	pool, e := postgres.Open(ctx, os.Getenv("DATABASE_URL"))
	if e != nil {
		return fault.New("database_unavailable", 503)
	}
	defer pool.Close()
	if e = postgres.AssertRecoveryReady(ctx, pool); e != nil {
		return e
	}
	var adopted bool
	if e = pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM galaxy_go_jobs.control_v1 WHERE endpoint=$1 AND backend='river')", config.Endpoint).Scan(&adopted); e != nil {
		return fault.New("operations_jobs_schema_unavailable", 503)
	}
	if !adopted {
		return fault.New("operations_jobs_not_adopted", 409)
	}
	files, e := publication.NewFilesystem(config)
	if e != nil {
		return fault.New("site_publication_files_unavailable", 503)
	}
	authority, e := access.LoadWorker(ctx, pool, config.Endpoint, os.Getenv("GALAXY_OPERATIONS_CONFIG_FILE"))
	if e != nil {
		return e
	}
	service := &publication.Service{Pool: pool, Endpoint: config.Endpoint, PublicOrigin: config.PublicOrigin, Publisher: files, Authority: authority}
	queue, e := jobs.NewWithQueues(pool, func(ctx context.Context, t jobs.Task) (jobs.Outcome, error) {
		if t.Action != jobs.ContentPublication || t.Endpoint != config.Endpoint || t.SourceID != t.OperationID {
			return jobs.Outcome{}, fault.New("operations_job_source_changed", 409)
		}
		result, e := service.Execute(ctx, t.SourceID)
		return jobs.Outcome{Result: result}, e
	}, map[string]int{jobs.ContentPublication: 1})
	if e != nil {
		return e
	}
	if e = ctx.Err(); e != nil {
		return e
	}
	work, cancelWork := context.WithCancel(context.Background())
	defer cancelWork()
	if e = queue.Start(work); e != nil {
		return e
	}
	slog.Info("Go content publisher started", "domains", []string{jobs.ContentPublication}, "cutover", "explicitly-adopted")
	<-ctx.Done()
	service.Stop()
	shutdown, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	e = queue.Stop(shutdown)
	if e != nil {
		cancelWork()
		cleanup, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		_ = queue.Stop(cleanup)
	}
	return e
}
func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if e := run(ctx); e != nil {
		slog.Error("Go content publisher stopped", "code", fault.Code(e))
		os.Exit(1)
	}
}
