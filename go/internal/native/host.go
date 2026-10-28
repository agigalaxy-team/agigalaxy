package native

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

// ServeHost is a separate, inherited-stdio channel for the trusted host adapter.
// These persistence operations are never exposed in the model's MCP tool list.
// Calls execute once in input order; a broken pipe is not a reason to replay writes.
func ServeHost(ctx context.Context, store *Store, input io.Reader, output io.Writer) error {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 64*1024), 9*1024*1024)
	for scanner.Scan() {
		if e := ctx.Err(); e != nil {
			return e
		}
		var request struct {
			ID     string          `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		raw := scanner.Bytes()
		e := protocol.Decode(raw, &request)
		if !utf8.Valid(raw) || request.ID == "" || len(request.ID) > 256 || request.Method == "" {
			e = fault.New("native_host_request_invalid", 400)
		}
		var result any
		if e == nil {
			result, e = store.hostCall(ctx, request.Method, request.Params)
		}
		response := map[string]any{"id": request.ID}
		if e != nil {
			response["error"] = map[string]string{"code": fault.Code(e)}
		} else {
			response["result"] = result
		}
		encoded, e := protocol.Encode(response)
		if e != nil {
			return e
		}
		if _, e = output.Write(append(encoded, '\n')); e != nil {
			return e
		}
	}
	if scanner.Err() != nil {
		return fault.New("native_host_input_failed", 400)
	}
	return nil
}

func hostDecode[T any](raw json.RawMessage) (T, error) {
	var input T
	b := bytes.TrimSpace(raw)
	if len(b) == 0 || b[0] != '{' {
		return input, fault.New("native_host_params_invalid", 400)
	}
	e := protocol.Decode(raw, &input)
	return input, e
}

func (s *Store) hostCall(ctx context.Context, method string, params json.RawMessage) (any, error) {
	switch method {
	case "native.preparationStatus":
		if _, e := hostDecode[struct{}](params); e != nil {
			return nil, e
		}
		return s.OpenCodePreparationStatus(ctx)
	case "native.deferPreparation":
		if _, e := hostDecode[struct{}](params); e != nil {
			return nil, e
		}
		return nil, s.SetOpenCodePreparationDeferred(ctx, true)
	case "native.initialize":
		x, e := hostDecode[InitializationInput](params)
		if e != nil {
			return nil, e
		}
		scope, e := s.ChoiceScope(ctx)
		if e != nil {
			return nil, e
		}
		result, e := s.Initialize(ctx, x, true, &scope)
		if e != nil {
			return nil, e
		}
		if e = s.SetOpenCodePreparationDeferred(ctx, false); e != nil {
			return nil, e
		}
		return result, nil
	case "history.identity":
		if _, e := hostDecode[struct{}](params); e != nil {
			return nil, e
		}
		id, e := s.Owner(ctx)
		if e != nil || id == "" {
			return nil, e
		}
		return map[string]string{"id": id}, nil
	case "history.beginCapture":
		var x struct {
			GalaxyID   string `json:"galaxyId"`
			Host       string `json:"host"`
			SessionID  string `json:"sessionId"`
			ObservedAt string `json:"observedAt,omitempty"`
		}
		var e error
		x, e = hostDecode[struct {
			GalaxyID   string `json:"galaxyId"`
			Host       string `json:"host"`
			SessionID  string `json:"sessionId"`
			ObservedAt string `json:"observedAt,omitempty"`
		}](params)
		if e != nil {
			return nil, e
		}
		return s.BeginWorkCapture(ctx, WorkEnvironmentInput{GalaxyID: x.GalaxyID, Host: x.Host, SessionID: x.SessionID, ObservedAt: x.ObservedAt})
	case "history.observeEnvironment":
		x, e := hostDecode[WorkEnvironmentInput](params)
		if e != nil {
			return nil, e
		}
		return s.ObserveWorkEnvironment(ctx, x)
	case "history.observe":
		x, e := hostDecode[WorkObservationInput](params)
		if e != nil {
			return nil, e
		}
		return s.ObserveWork(ctx, x)
	case "history.list", "history.get", "history.pending":
		x, e := hostDecode[WorkQuery](params)
		if e != nil {
			return nil, e
		}
		if method == "history.list" {
			return s.WorkList(ctx, x)
		}
		if method == "history.get" {
			return s.WorkGet(ctx, x)
		}
		return s.WorkPending(ctx, x)
	case "history.setSummaryState":
		x, e := hostDecode[WorkSummaryStateInput](params)
		if e != nil {
			return nil, e
		}
		return nil, s.SetWorkSummaryState(ctx, x)
	case "history.submitSummary":
		x, e := hostDecode[WorkSummaryInput](params)
		if e != nil {
			return nil, e
		}
		return s.SubmitWorkSummary(ctx, x)
	case "archive.settings":
		if _, e := hostDecode[struct{}](params); e != nil {
			return nil, e
		}
		return s.ArchiveSettings(ctx)
	case "archive.captureMessage":
		x, e := hostDecode[ArchiveCaptureInput](params)
		if e != nil {
			return nil, e
		}
		return s.CaptureArchiveMessage(ctx, x)
	case "archive.configure":
		x, e := hostDecode[ArchiveInput](params)
		if e != nil {
			return nil, e
		}
		// The host menu already obtained the person's selection. Bind this write
		// to that submitted owner and the current device/selection, not model text.
		if x.GalaxyID == "" {
			return nil, fault.New("local_archive_identity_required", 409)
		}
		scope, e := s.ChoiceScope(ctx)
		if e != nil {
			return nil, e
		}
		return s.configureArchive(ctx, x, &scope)
	default:
		return nil, fault.New("native_host_method_unknown", 404)
	}
}
