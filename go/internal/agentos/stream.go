package agentos

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

func index(value any) (int64, bool) {
	var n float64
	switch v := value.(type) {
	case json.Number:
		var e error
		n, e = v.Float64()
		if e != nil {
			return 0, false
		}
	case float64:
		n = v
	case int64:
		return v, v >= 0 && v <= 9007199254740991
	case int:
		n = float64(v)
	default:
		return 0, false
	}
	return int64(n), !math.IsNaN(n) && !math.IsInf(n, 0) && n >= 0 && n <= 9007199254740991 && math.Trunc(n) == n
}
func streamInvalid() error { return fail("operations_agentos_response_invalid", 503) }

// ReadNativeFrames bounds one frame, validates UTF-8 and requires complete SSE
// delimiters. Returning false stops observation; it never cancels a native run.
func ReadNativeFrames(body io.Reader, yield func(Object) (bool, error)) error {
	if body == nil {
		return streamInvalid()
	}
	reader := bufio.NewReaderSize(body, 32768)
	var line []byte
	data := []string{}
	frameBytes := 0
	first := true
	for {
		part, e := reader.ReadSlice('\n')
		line = append(line, part...)
		if len(line)+frameBytes > 1024*1024+2 {
			return streamInvalid()
		}
		if e == bufio.ErrBufferFull {
			continue
		}
		if e != nil && e != io.EOF {
			return e
		}
		if e == io.EOF {
			if !utf8.Valid(line) || strings.Trim(string(line), " \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff") != "" || len(data) > 0 {
				return streamInvalid()
			}
			return nil
		}
		line = line[:len(line)-1]
		if len(line) > 0 && line[len(line)-1] == '\r' {
			line = line[:len(line)-1]
		}
		if first {
			line = []byte(strings.TrimPrefix(string(line), "\ufeff"))
			first = false
		}
		if !utf8.Valid(line) {
			return streamInvalid()
		}
		frameBytes += len(line)
		if frameBytes > 1024*1024 {
			return streamInvalid()
		}
		text := string(line)
		line = nil
		if text == "" {
			joined := strings.Join(data, "\n")
			data = nil
			frameBytes = 0
			if joined == "" {
				continue
			}
			var value any
			if protocol.Decode([]byte(joined), &value) != nil {
				return streamInvalid()
			}
			if frame := object(value); frame != nil {
				keep, e := yield(frame)
				if e != nil {
					return e
				}
				if !keep {
					return nil
				}
			}
			continue
		}
		if strings.HasPrefix(text, ":") {
			continue
		}
		key, value, found := strings.Cut(text, ":")
		if !found {
			value = ""
		}
		value = strings.TrimPrefix(value, " ")
		if key == "data" {
			data = append(data, value)
		}
	}
}

// ConversationStreamEvent is the existing closed, non-reasoning projection.
// No unrecognized native frame or tool arguments become browser output.
func ConversationStreamEvent(frame Object, runID string, after int64) Object {
	if frame == nil {
		return nil
	}
	if frame["event"] == "error" {
		if _, present := frame["run_id"]; !present {
			return Object{"kind": "resync", "eventIndex": nil}
		}
	}
	if frame["run_id"] != runID {
		return nil
	}
	n, ok := index(frame["event_index"])
	var position any
	if ok {
		position = n
		if n <= after {
			return nil
		}
	}
	event, valid := frame["event"].(string)
	if !valid || strings.Contains(event, "Reasoning") {
		return nil
	}
	switch event {
	case "RunContent":
		text, okText := frame["content"].(string)
		if !okText {
			return nil
		}
		if contentType, present := frame["content_type"]; present && contentType != "str" {
			return nil
		}
		if !ok {
			return Object{"kind": "resync", "eventIndex": nil}
		}
		return Object{"kind": "text", "eventIndex": position, "text": text}
	case "ToolCallStarted":
		if !ok {
			return Object{"kind": "resync", "eventIndex": nil}
		}
		return Object{"kind": "reset", "eventIndex": position, "phase": "working"}
	case "ToolCallCompleted", "RunStarted", "RunContentCompleted":
		return Object{"kind": "phase", "eventIndex": position, "phase": "generating"}
	}
	terminal := map[string]string{"RunCompleted": "COMPLETED", "RunCancelled": "CANCELLED", "RunError": "ERROR", "RunPaused": "PAUSED"}
	if status, present := terminal[event]; present {
		return Object{"kind": "terminal", "eventIndex": position, "status": status}
	}
	if event == "replay" || event == "catch_up" || event == "subscribed" || event == "stream_expired" || event == "error" {
		status, _ := frame["status"].(string)
		status = strings.ToUpper(status)
		kind := "phase"
		if event == "error" || event == "stream_expired" || status == "COMPLETED" || status == "PAUSED" || status == "CANCELLED" || status == "ERROR" {
			kind = "resync"
		}
		out := Object{"kind": kind, "eventIndex": position, "phase": "waiting"}
		if status == "PENDING" || status == "RUNNING" || status == "COMPLETED" || status == "PAUSED" || status == "CANCELLED" || status == "ERROR" {
			out["status"] = status
		}
		return out
	}
	return nil
}

func (c *Client) streamRequest(ctx context.Context, e Execution, path string, form url.Values, key string) (*http.Response, context.CancelFunc, error) {
	token, err := c.token(e)
	if err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	r, err := http.NewRequestWithContext(ctx, "POST", c.configuration.URL+path, strings.NewReader(form.Encode()))
	if err != nil {
		cancel()
		return nil, nil, fail("operations_agentos_configuration_invalid", 503)
	}
	r.GetBody = nil
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	r.Header.Set("Accept", "text/event-stream")
	if key != "" {
		r.Header.Set("Idempotency-Key", key)
	}
	response, err := c.http.Do(r)
	if err != nil {
		cancel()
		return nil, nil, fail("operations_agentos_result_unknown", 503)
	}
	closeResponse := func() { _ = response.Body.Close(); cancel() }
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		closeResponse()
		if response.StatusCode == 403 {
			return nil, nil, fail("operations_agentos_authority_changed", 403)
		}
		return nil, nil, fail("operations_agentos_request_failed", 503)
	}
	if !strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
		closeResponse()
		return nil, nil, streamInvalid()
	}
	return response, closeResponse, nil
}

type ConversationRun struct {
	RunID, Message, RetryOfRunID, RetryOfOperationID string
	Stream                                           bool
}

var nativeRunID = regexp.MustCompile(`^[-A-Za-z0-9_]{1,128}$`)

func (c *Client) RunConversation(ctx context.Context, e Execution, input ConversationRun) (any, error) {
	path := "/agents/galaxy-conversation-" + url.PathEscape(e.Domain) + "/runs"
	form := url.Values{"message": {input.Message}, "stream": {"false"}, "background": {"true"}, "session_id": {e.SessionID}}
	if input.Stream {
		form.Set("stream", "true")
	}
	if input.RetryOfRunID != "" {
		path += "/" + url.PathEscape(input.RetryOfRunID) + "/continue"
		form.Del("message")
		form.Set("regenerate", "true")
		form.Set("replace_original", "true")
		form.Set("retry_of_operation_id", input.RetryOfOperationID)
	}
	if !input.Stream {
		return c.request(ctx, e, path, form, input.RunID)
	}
	response, closeResponse, err := c.streamRequest(ctx, e, path, form, input.RunID)
	if err != nil {
		return nil, err
	}
	defer closeResponse()
	var accepted Object
	err = ReadNativeFrames(response.Body, func(frame Object) (bool, error) {
		id, ok := frame["run_id"].(string)
		if !ok || !nativeRunID.MatchString(id) {
			return true, nil
		}
		if session, present := frame["session_id"]; present && session != e.SessionID {
			return false, streamInvalid()
		}
		if agent, present := frame["agent_id"]; present && agent != "galaxy-conversation-"+e.Domain {
			return false, streamInvalid()
		}
		accepted = Object{"run_id": id, "status": "PENDING"}
		return false, nil
	})
	if err != nil {
		return nil, err
	}
	if accepted == nil {
		return nil, fail("operations_agentos_result_unknown", 503)
	}
	return accepted, nil
}
func (c *Client) ConversationEvents(ctx context.Context, e Execution, runID string, after int64, yield func(Object) error) error {
	form := url.Values{"session_id": {e.SessionID}}
	if after >= 0 {
		form.Set("last_event_index", strconv.FormatInt(after, 10))
	}
	response, closeResponse, err := c.streamRequest(ctx, e, "/agents/galaxy-conversation-"+url.PathEscape(e.Domain)+"/runs/"+url.PathEscape(runID)+"/resume", form, "")
	if err != nil {
		return err
	}
	defer closeResponse()
	return ReadNativeFrames(response.Body, func(frame Object) (bool, error) {
		event := ConversationStreamEvent(frame, runID, after)
		if event == nil {
			return true, nil
		}
		if position, ok := index(event["eventIndex"]); ok {
			after = position
		}
		if err := yield(event); err != nil {
			return false, err
		}
		return event["kind"] != "terminal" && event["kind"] != "resync", nil
	})
}
