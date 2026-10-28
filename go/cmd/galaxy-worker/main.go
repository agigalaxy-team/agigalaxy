package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationalmetrics"
	"github.com/agigalaxy-team/agigalaxy/go/internal/runtimelog"
	"github.com/agigalaxy-team/agigalaxy/go/internal/workerconfig"
)

func run(ctx context.Context) error {
	configuration, e := runtimelog.LoadConfiguration(os.LookupEnv)
	if e != nil {
		return e
	}
	logger, e := runtimelog.New(runtimelog.Options{Component: "worker", Configuration: configuration})
	if e != nil {
		return e
	}
	started := time.Now()
	e = serve(ctx, logger)
	if e == nil {
		logger.Write(runtimelog.Event{"event": "runtime_stopped", "exitCode": 0, "durationMs": time.Since(started)})
	}
	closed := logger.Close()
	if e != nil {
		return e
	}
	return closed
}

func serve(ctx context.Context, runtimeLog *runtimelog.Logger) (result error) {
	logger := slog.New(runtimeLog.Handler())
	started := false
	defer func() {
		if result != nil {
			event := "worker_startup_failed"
			if started {
				event = "worker_shutdown_failed"
			}
			logger.Error(event, "error", result)
		}
	}()
	if os.Geteuid() == 0 {
		return fault.New("non_root_runtime_required", 400)
	}
	config, e := workerconfig.Load(os.Getenv)
	if e != nil {
		return e
	}
	config.Diagnostic = func(stage, id, code string) {
		logger.Warn("attachment_processing_deferred", "stage", stage, "sourceId", id, "code", code)
	}
	runtime, e := workerconfig.Open(ctx, config)
	if e != nil {
		return e
	}
	defer runtime.Close()
	metricsConfig, e := operationalmetrics.LoadConfiguration(os.LookupEnv)
	if e != nil {
		return e
	}
	// Worker has no backup-file collector in the existing process contract.
	metricsConfig.BackupStatusDirectory = ""
	metrics, e := operationalmetrics.New(operationalmetrics.Options{Component: "worker", Configuration: metricsConfig, Pool: runtime.Pool, LogStatus: runtimeLog.Status})
	if e != nil {
		return e
	}
	listener, e := operationalmetrics.StartListener(metrics, metricsConfig.Port)
	if e != nil {
		return e
	}
	defer listener.Close()
	logger.Info("runtime_started", "stage", "worker-ready")
	started = true
	result = runtime.Run(ctx)
	logger.Info("runtime_stopping", "stage", "shutdown")
	return result
}
func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if e := run(ctx); e != nil {
		slog.Error("Go feedback worker stopped", "code", fault.Code(e))
		os.Exit(1)
	}
}
