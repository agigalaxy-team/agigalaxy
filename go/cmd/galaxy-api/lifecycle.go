package main

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/incident"
	"github.com/agigalaxy-team/agigalaxy/go/internal/retirement"
	"github.com/agigalaxy-team/agigalaxy/go/internal/webevents"
	"github.com/google/uuid"
)

func lifecycleHandler(retired *retirement.Controller, incident *incident.Controller, ready func(context.Context) bool, events *webevents.Service, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		send := func(status int, value any) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(value)
		}
		failed := func(err error) {
			request := w.Header().Get("X-Request-Id")
			if request == "" {
				request = uuid.NewString()
			}
			send(fault.Status(err), map[string]any{"error": fault.Code(err), "requestId": request})
		}
		if r.Method == "GET" && r.URL.Path == "/healthz" {
			send(200, map[string]any{"status": "ok"})
			return
		}
		if r.Method == "GET" && r.URL.Path == "/readyz" {
			if ready != nil && ready(r.Context()) && incident.CanProcessEvidence() {
				send(200, map[string]any{"status": "ready"})
			} else {
				send(503, map[string]any{"status": "unavailable"})
			}
			return
		}
		if err := incident.AssertRoute(r.Method, r.URL.EscapedPath()); err != nil {
			failed(err)
			return
		}
		if err := retired.AssertRoute(r.Method, r.URL.EscapedPath()); err != nil {
			failed(err)
			return
		}
		if r.Method == "GET" && r.URL.Path == "/v1/service-status" {
			snapshot, incidentState := retired.Snapshot(), incident.Snapshot()
			snapshot.BusinessWritesAccepted = snapshot.BusinessWritesAccepted && incidentState.BusinessWritesAccepted
			snapshot.DownloadsAccepted = snapshot.DownloadsAccepted && incidentState.SharingAccepted
			send(200, struct {
				retirement.Snapshot
				Incident any `json:"incident"`
			}{snapshot, incidentState})
			return
		}
		if r.Method == "GET" && events != nil && r.URL.Path != "/v1/web-events" && r.URL.Path != "/v1/operations/web-events" {
			position, err := events.Position(r.Context())
			if err != nil {
				failed(err)
				return
			}
			w.Header().Set("X-Galaxy-Event-Cursor", position)
		}
		next.ServeHTTP(w, r)
	})
}
