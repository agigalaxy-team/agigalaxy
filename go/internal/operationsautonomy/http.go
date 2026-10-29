package operationsautonomy

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

type Handler struct {
	Service *Service
	Next    http.Handler
}

var configPath = regexp.MustCompile(`^/v1/operations/autonomy/accounts/(overview|governance|messaging|discovery|maintenance)/config$`)
var runPath = regexp.MustCompile(`^/v1/operations/autonomy/accounts/(overview|governance|messaging|discovery|maintenance)/run$`)
var taskPath = regexp.MustCompile(`^/v1/operations/autonomy/tasks/([0-9a-f-]{36})(?:/(control|decisions))?$`)
var taskOperationPath = regexp.MustCompile(`^/v1/operations/autonomy/tasks/([0-9a-f-]{36})/operations/([0-9a-f-]{36})$`)
var operationPath = regexp.MustCompile(`^/v1/operations/autonomy/operations/([0-9a-f-]{36})$`)

func readBody(r *http.Request, limit int64) (Object, error) {
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return nil, fault.New("unsupported_media_type", 415)
	}
	b, e := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if e != nil || int64(len(b)) > limit {
		return nil, fault.New("request_too_large", 413)
	}
	if !utf8.Valid(b) || !json.Valid(b) {
		return nil, fault.New("invalid_json", 400)
	}
	var x Object
	if json.Unmarshal(b, &x) != nil || x == nil {
		return nil, fault.New("invalid_request", 400)
	}
	return x, nil
}
func queryValues(raw string) (url.Values, error) {
	return url.ParseQuery(strings.ReplaceAll(raw, ";", "%3B"))
}
func queryNumber(s string) (float64, error) {
	s = trim(s)
	if s == "" {
		return 0, nil
	}
	for prefix, base := range map[string]int{"0x": 16, "0X": 16, "0b": 2, "0B": 2, "0o": 8, "0O": 8} {
		if strings.HasPrefix(s, prefix) {
			n, e := strconv.ParseUint(s[2:], base, 64)
			return float64(n), e
		}
	}
	return strconv.ParseFloat(s, 64)
}
func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	const root = "/v1/operations/autonomy"
	path := r.URL.EscapedPath()
	if path != root && !strings.HasPrefix(path, root+"/") {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			respond(w, nil, fault.New("not_found", 404))
		}
		return
	}
	s := h.Service
	if s == nil || s.Authority == nil {
		respond(w, nil, fault.New("operations_autonomy_unavailable", 503))
		return
	}
	config, run, task, operation := configPath.FindStringSubmatch(path), runPath.FindStringSubmatch(path), taskPath.FindStringSubmatch(path), operationPath.FindStringSubmatch(path)
	taskOperation := taskOperationPath.FindStringSubmatch(path)
	write := r.Method == "POST"
	if r.Method != "GET" && !write {
		respond(w, nil, fault.New("not_found", 404))
		return
	}
	if write && r.URL.RawQuery != "" {
		respond(w, nil, invalid())
		return
	}
	action := "autonomy.read"
	if write {
		action = "autonomy.control"
		if config != nil || path == root+"/enable" || path == root+"/settings" {
			action = "autonomy.configure"
		}
	}
	actor, e := s.Authority.AuthorizeOperations(r, write, action)
	if e != nil {
		respond(w, nil, e)
		return
	}
	authorize := func(_ context.Context) (Actor, error) { return s.Authority.AuthorizeOperations(r, write, action) }
	w.Header().Set("Cache-Control", "no-store")
	var out Object
	body := func(limit int64) Object {
		if e != nil {
			return nil
		}
		var x Object
		x, e = readBody(r, limit)
		return x
	}
	notFound := func() { e = fault.New("not_found", 404) }
	switch {
	case path == root+"/options" && !write && r.URL.RawQuery == "":
		out, e = s.Options(r.Context(), actor)
	case path == root+"/settings" && r.URL.RawQuery == "":
		if write {
			x := body(4096)
			if e == nil {
				out, e = s.SaveSettings(r.Context(), actor, x, authorize)
			}
		} else {
			out, e = s.Settings(r.Context(), actor)
		}
	case path == root+"/overview" && !write:
		q, err := queryValues(r.URL.RawQuery)
		days := 7
		if err != nil {
			e = invalid()
			break
		}
		for k, v := range q {
			if k != "days" || len(v) != 1 || !regexp.MustCompile(`^[1-9][0-9]?$`).MatchString(v[0]) {
				e = invalid()
				break
			}
			days, _ = strconv.Atoi(v[0])
		}
		if e == nil {
			out, e = s.Overview(r.Context(), actor, days)
		}
	case path == root+"/tasks" && write:
		x := body(4096)
		if e == nil {
			out, e = s.CreateStrategyTask(r.Context(), actor, x, authorize)
		}
	case path == root+"/tasks":
		q, err := queryValues(r.URL.RawQuery)
		if err != nil {
			e = invalid()
			break
		}
		input := Object{}
		for k, v := range q {
			if !has([]string{"page", "limit", "domain", "source", "state", "mode", "targetType", "targetId"}, k) || len(v) != 1 {
				e = invalid()
				break
			}
			if k == "page" || k == "limit" {
				n, err := queryNumber(v[0])
				if err != nil {
					e = invalid()
					break
				}
				input[k] = n
			} else {
				input[k] = v[0]
			}
		}
		if e == nil {
			out, e = s.Tasks(r.Context(), actor, input)
		}
	case taskOperation != nil && !write && r.URL.RawQuery == "":
		out, e = s.OriginalAIReceipt(r.Context(), actor, taskOperation[1], taskOperation[2])
	case task != nil:
		if write && task[2] != "" {
			x := body(2048)
			if e == nil {
				if task[2] == "decisions" {
					out, e = s.Decide(r.Context(), actor, task[1], x, authorize)
				} else {
					out, e = s.Control(r.Context(), actor, task[1], x, authorize)
				}
			}
		} else if !write && task[2] == "" && r.URL.RawQuery == "" {
			out, e = s.GetTask(r.Context(), actor, task[1])
		} else {
			notFound()
		}
	case operation != nil && !write && r.URL.RawQuery == "":
		out, e = s.Operation(r.Context(), actor, operation[1])
	case config != nil:
		if !write && r.URL.RawQuery != "" {
			e = invalid()
		} else if write {
			x := body(65536)
			if e == nil {
				out, e = s.SaveConfig(r.Context(), actor, config[1], x, authorize)
			}
		} else {
			out, e = s.GetConfig(r.Context(), actor, config[1])
		}
	case run != nil && write:
		x := body(2048)
		if e == nil {
			out, e = s.Run(r.Context(), actor, run[1], x, authorize)
		}
	case path == root+"/enable" && write:
		x := body(4096)
		if e == nil {
			out, e = s.Enable(r.Context(), actor, x, authorize)
		}
	default:
		notFound()
	}
	respond(w, out, e)
}
