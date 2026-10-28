package webevents

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

type Handler struct {
	Service   *Service
	Heartbeat time.Duration
}

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	fail := func(e error) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(fault.Status(e))
		json.NewEncoder(w).Encode(map[string]any{"error": fault.Code(e)})
	}
	surface := "web"
	if r.URL.Path == "/v1/operations/web-events" {
		surface = "admin"
	} else if r.URL.Path != "/v1/web-events" {
		fail(fault.New("not_found", 404))
		return
	}
	if r.Method != "GET" {
		fail(fault.New("not_found", 404))
		return
	}
	if h.Service == nil {
		fail(fault.New("web_events_unavailable", 503))
		return
	}
	// ParseQuery rejects invalid escaping rather than silently dropping a filter.
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		fail(fault.New("invalid_web_events_request", 400))
		return
	}
	for key, values := range query {
		if (key != "cursor" && key != "topics" && key != "stream") || len(values) != 1 {
			fail(fault.New("invalid_web_events_request", 400))
			return
		}
	}
	var cursor *string
	if query.Has("cursor") {
		v := query.Get("cursor")
		cursor = &v
	} else if values, ok := r.Header["Last-Event-Id"]; ok {
		if len(values) != 1 {
			fail(fault.New("invalid_web_events_cursor", 400))
			return
		}
		cursor = &values[0]
	}
	if cursor != nil && !integer.MatchString(*cursor) {
		fail(fault.New("invalid_web_events_cursor", 400))
		return
	}
	var topics []string
	if query.Has("topics") {
		topics = strings.Split(query.Get("topics"), ",")
	}
	if query.Has("stream") && query.Get("stream") != "true" && query.Get("stream") != "false" {
		fail(fault.New("invalid_web_events_request", 400))
		return
	}
	c, err := h.Service.Connect(r.Context(), r, surface, topics)
	if err != nil {
		fail(err)
		return
	}
	if query.Get("stream") == "false" {
		events, err := h.Service.Read(r.Context(), c, cursor)
		if err != nil {
			fail(err)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(map[string]any{"cursor": events[len(events)-1].Cursor, "modules": c.Modules, "events": events})
		return
	}
	if _, ok := w.(http.Flusher); !ok {
		fail(fault.New("web_events_stream_unavailable", 503))
		return
	}
	notifications, unsubscribe, err := h.Service.Subscribe(r.Context())
	if err != nil {
		fail(err)
		return
	}
	defer unsubscribe()
	// Subscribe before read closes the initial snapshot/notification race.
	events, err := h.Service.Read(r.Context(), c, cursor)
	if err != nil {
		fail(err)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)
	controller := http.NewResponseController(w)
	write := func(events []Frame) bool {
		for _, event := range events {
			b, e := json.Marshal(event)
			if e != nil {
				return false
			}
			controller.SetWriteDeadline(time.Now().Add(15 * time.Second))
			if _, e = fmt.Fprintf(w, "id: %s\ndata: %s\n\n", event.Cursor, b); e != nil {
				return false
			}
			v := event.Cursor
			cursor = &v
		}
		return controller.Flush() == nil
	}
	if !write(events) {
		return
	}
	heartbeat := h.Heartbeat
	if heartbeat <= 0 {
		heartbeat = 15 * time.Second
	}
	timer := time.NewTicker(heartbeat)
	defer timer.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-notifications:
		case <-timer.C:
		}
		events, err = h.Service.Read(r.Context(), c, cursor)
		if err != nil {
			if status := fault.Status(err); status == 401 || status == 403 || status == 409 || status == 410 {
				v := "0"
				if cursor != nil {
					v = *cursor
				}
				b, _ := json.Marshal(Frame{Type: "reset", Cursor: v, Modules: c.Modules})
				controller.SetWriteDeadline(time.Now().Add(15 * time.Second))
				fmt.Fprintf(w, "data: %s\n\n", b)
				controller.Flush()
			}
			return
		}
		if !write(events) {
			return
		}
	}
}
