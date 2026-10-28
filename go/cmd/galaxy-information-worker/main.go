package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/informationworker"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/runtimelog"
)

func serve(ctx context.Context, getenv func(string) string, logger *slog.Logger) error {
	if os.Geteuid() == 0 {
		return fault.New("non_root_runtime_required", 400)
	}
	c, e := informationworker.Load(getenv)
	if e != nil {
		return e
	}
	source, e := postgres.Open(ctx, c.SourceDatabaseURL)
	if e != nil {
		return fault.New("information_source_database_unavailable", 503)
	}
	defer source.Close()
	transport, e := postgres.Open(ctx, c.TransportDatabaseURL)
	if e != nil {
		return fault.New("information_transport_database_unavailable", 503)
	}
	defer transport.Close()
	if e = postgres.AssertRecoveryReady(ctx, source); e != nil {
		return e
	}
	// The existing administrative endpoint cutover remains explicit. An empty
	// queue is not proof that an unadopted scheduler is ready to replace Node.
	var adopted bool
	if e = source.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM galaxy_go_jobs.control_v1 WHERE endpoint=$1 AND backend='river')`, c.Sources.Endpoint).Scan(&adopted); e != nil {
		return fault.New("operations_jobs_schema_unavailable", 503)
	}
	if !adopted {
		return fault.New("operations_jobs_not_adopted", 409)
	}
	c.Sources.Logger = logger
	sources, e := informationworker.NewSources(ctx, source, c.Sources)
	if e != nil {
		return e
	}
	defer sources.Close()
	runtime, e := informationworker.New(ctx, informationworker.Config{SourcePool: source, TransportPool: transport, Endpoint: c.Sources.Endpoint, Watches: sources.Watches, Logger: logger})
	if e != nil {
		return e
	}
	if e = runtime.Start(ctx); e != nil {
		return e
	}
	logger.Info("runtime_started", "stage", "information-worker-ready")
	<-ctx.Done()
	logger.Info("runtime_stopping", "stage", "information-worker-shutdown")
	shutdown, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return runtime.Stop(shutdown)
}
func run(ctx context.Context) error {
	c, e := runtimelog.LoadConfiguration(os.LookupEnv)
	if e != nil {
		return e
	}
	log, e := runtimelog.New(runtimelog.Options{Component: "worker", Configuration: c})
	if e != nil {
		return e
	}
	logger := slog.New(log.Handler())
	result := serve(ctx, os.Getenv, logger)
	if result != nil {
		logger.Error("information_worker_stopped", "code", fault.Code(result))
	} else {
		logger.Info("runtime_stopped", "exitCode", 0)
	}
	closed := log.Close()
	if result != nil {
		return result
	}
	return closed
}
func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if e := run(ctx); e != nil {
		slog.Error("Information worker stopped", "code", fault.Code(e))
		os.Exit(1)
	}
}
