package main

import (
	"context"
	"os"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/runtimelog"
)

func run(ctx context.Context) error {
	configuration, err := runtimelog.LoadConfiguration(os.LookupEnv)
	if err != nil {
		return err
	}
	log, err := runtimelog.New(runtimelog.Options{Component: "api", Configuration: configuration})
	if err != nil {
		return err
	}
	started := time.Now()
	err = serve(ctx, log)
	if err == nil {
		log.Write(runtimelog.Event{"event": "runtime_stopped", "exitCode": 0, "durationMs": time.Since(started)})
	}
	closed := log.Close()
	if err != nil {
		return err
	}
	return closed
}
