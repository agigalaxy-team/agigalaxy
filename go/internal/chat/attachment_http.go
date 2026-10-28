package chat

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"io"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"
)

type AttachmentHandler struct {
	Service  *AttachmentService
	Identity HTTPIdentity
	Next     http.Handler
}

func readChatBody(r *http.Request) ([]byte, Object, error) {
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return nil, nil, fail("unsupported_media_type", 415)
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, 32769))
	if e != nil {
		return nil, nil, e
	}
	if len(raw) > 32768 {
		return nil, nil, fail("request_too_large", 413)
	}
	if !utf8.Valid(raw) || !json.Valid(raw) {
		return nil, nil, fail("invalid_json")
	}
	var input Object
	if json.Unmarshal(raw, &input) != nil || input == nil {
		return nil, nil, fail("invalid_request")
	}
	return raw, input, nil
}
func (h AttachmentHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	prefix := "/v2/chat/attachments/"
	path := strings.TrimPrefix(r.URL.Path, prefix)
	parts := strings.Split(path, "/")
	binary := len(parts) == 2 && validID(parts[0]) && has([]string{"upload", "content", "export-content"}, parts[1])
	matched := r.Method == "POST" && has([]string{"config", "prepare", "read", "query", "revoke"}, path) || binary && (parts[1] == "upload" && r.Method == "PUT" || parts[1] != "upload" && r.Method == "POST")
	if !strings.HasPrefix(r.URL.Path, prefix) || !matched {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	id := uuid.NewString()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Request-ID", id)
	out, content, e := h.dispatch(r, path, parts, binary)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		json.NewEncoder(w).Encode(Object{"error": fault.Code(e), "requestId": id})
		return
	}
	if content != nil {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.Itoa(len(content.Bytes)))
		w.Header().Set("Content-Disposition", `attachment; filename="galaxy-attachment"; filename*=UTF-8''`+attachmentName(content.Name))
		w.Header().Set("X-Galaxy-Content-Sha256", content.SHA256)
		w.WriteHeader(200)
		w.Write(content.Bytes)
		return
	}
	json.NewEncoder(w).Encode(out)
}
func attachmentName(name string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for _, v := range []byte(name) {
		if v >= 'a' && v <= 'z' || v >= 'A' && v <= 'Z' || v >= '0' && v <= '9' || v == '-' || v == '.' || v == '_' || v == '~' {
			b.WriteByte(v)
		} else {
			b.WriteByte('%')
			b.WriteByte(hex[v>>4])
			b.WriteByte(hex[v&15])
		}
	}
	return b.String()
}
func (h AttachmentHandler) dispatch(r *http.Request, path string, parts []string, binary bool) (Object, *AttachmentContent, error) {
	f := h.Service
	if f == nil || f.Chat == nil {
		return nil, nil, fail("attachment_service_unavailable", 503)
	}
	write := path == "prepare" || path == "revoke" || binary && parts[1] == "upload"
	a, e := (Handler{Service: f.Chat, Identity: h.Identity}).actor(r, write)
	if e != nil {
		return nil, nil, e
	}
	ctx := r.Context()
	if binary && parts[1] == "upload" {
		if r.Header.Get("Content-Encoding") != "" || len(r.TransferEncoding) > 0 || r.Header.Get("Transfer-Encoding") != "" || !digits.MatchString(r.Header.Get("Content-Length")) {
			return nil, nil, fail("attachment_length_required", 411)
		}
		length, e := strconv.ParseInt(r.Header.Get("Content-Length"), 10, 64)
		if e != nil {
			return nil, nil, fail("attachment_size_mismatch", 400)
		}
		result, e := f.Upload(ctx, a, parts[0], r.Body, length, r.Header.Get("Content-Type"), nil)
		return result, nil, e
	}
	raw, input, e := readChatBody(r)
	if e != nil {
		return nil, nil, e
	}
	if binary {
		if len(input) != 0 {
			return nil, nil, fail("invalid_request")
		}
		content, e := f.Content(ctx, a, encode(Object{"attachmentId": parts[0]}), parts[1] == "export-content")
		return nil, &content, e
	}
	switch path {
	case "config":
		if len(input) != 0 {
			return nil, nil, fail("invalid_request")
		}
		return f.Specification(), nil, nil
	case "prepare":
		result, e := f.Prepare(ctx, a, raw)
		return result, nil, e
	case "read":
		result, e := f.Get(ctx, a, raw)
		return result, nil, e
	case "query":
		result, e := f.QueryOwn(ctx, a, raw)
		return result, nil, e
	case "revoke":
		result, e := f.Revoke(ctx, a, raw)
		return result, nil, e
	}
	return nil, nil, fail("not_found", 404)
}
