package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/feedback"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
)

func run(ctx context.Context) error {
	if os.Geteuid() == 0 {
		return fault.New("non_root_runtime_required", 400)
	}
	endpoint := os.Getenv("GALAXY_ENDPOINT")
	pool, e := postgres.Open(ctx, os.Getenv("DATABASE_URL"))
	if e != nil {
		return fault.New("database_unavailable", 503)
	}
	defer pool.Close()
	gateway, e := access.Load(ctx, pool, endpoint, os.Getenv("GALAXY_ACCOUNT_CONFIG_FILE"), os.Getenv("GALAXY_OPERATIONS_CONFIG_FILE"), os.Getenv("GALAXY_IDENTITY_CONFIG_FILE"))
	if e != nil {
		return e
	}
	service := &feedback.Service{Pool: pool, Endpoint: endpoint, Attachments: &feedback.AttachmentRepository{Endpoint: endpoint}}
	host := os.Getenv("GALAXY_LISTEN_HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	if host != "127.0.0.1" && host != "0.0.0.0" {
		return fault.New("listen_configuration_invalid", 400)
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "3001"
	}
	n, e := strconv.Atoi(port)
	if e != nil || n < 1024 || n > 65535 {
		return fault.New("listen_configuration_invalid", 400)
	}
	listener, e := net.Listen("tcp", net.JoinHostPort(host, port))
	if e != nil {
		return fault.New("listen_unavailable", 503)
	}
	server := &http.Server{Handler: feedback.Handler{Service: service, Identity: gateway}, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32768}
	// A first migrated module, not a replacement for the complete production
	// API yet. No migration, queue claimant or model is started here.
	slog.Info("Go API development entry listening", "address", listener.Addr().String(), "domains", []string{"feedback"})
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	select {
	case e = <-done:
		if errors.Is(e, http.ErrServerClosed) {
			return nil
		}
		return e
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		e := server.Shutdown(shutdown)
		if e != nil {
			_ = server.Close()
		}
		return e
	}
}
func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if e := run(ctx); e != nil {
		slog.Error("Go API stopped", "code", fault.Code(e))
		os.Exit(1)
	}
}
