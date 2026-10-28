package community

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

type AttachmentHandler struct {
	Service  *AttachmentService
	Identity HTTPIdentity
	Next     http.Handler
}

func (h AttachmentHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	prefix := "/v2/community/attachments/"
	path := strings.TrimPrefix(r.URL.Path, prefix)
	parts := strings.Split(path, "/")
	binary := len(parts) == 2 && validID(parts[0]) && hasString([]string{"upload", "content"}, parts[1])
	matched := r.Method == "POST" && hasString([]string{"config", "prepare", "read", "query", "revoke"}, path) || binary && (parts[1] == "upload" && r.Method == "PUT" || parts[1] == "content" && r.Method == "POST")
	if !strings.HasPrefix(r.URL.Path, prefix) || !matched {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	requestID := uuid.NewString()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Request-ID", requestID)
	out, content, e := h.dispatch(r, path, parts, binary)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		out = Object{"error": fault.Code(e), "requestId": requestID}
	} else if content != nil {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.Itoa(len(content.Bytes)))
		w.Header().Set("Content-Disposition", `attachment; filename="galaxy-attachment"; filename*=UTF-8''`+strings.ReplaceAll(url.QueryEscape(content.Name), "+", "%20"))
		w.Header().Set("X-Galaxy-Content-Sha256", content.SHA256)
		w.Write(content.Bytes)
		return
	}
	json.NewEncoder(w).Encode(out)
}
func (h AttachmentHandler) actor(r *http.Request, write, optional bool) (AttachmentActor, error) {
	var a AttachmentActor
	if _, present := r.Header["Authorization"]; present {
		if h.Service == nil || h.Service.Forum == nil || h.Service.Forum.DeviceAuth == nil {
			return a, fail("forum_identity_authorization_unavailable", 503)
		}
		header := r.Header.Get("Authorization")
		if !strings.HasPrefix(header, "Bearer ") {
			return a, fail("access_denied", 401)
		}
		scope := "binding"
		if write {
			scope = "assistance"
		}
		device, e := h.Service.Forum.DeviceAuth.Authenticate(r.Context(), strings.TrimPrefix(header, "Bearer "), scope)
		if e != nil {
			return a, e
		}
		a.Device = &device
		if _, present := r.Header["X-Galaxy-Account-Id"]; present {
			a.AccountID = r.Header.Get("X-Galaxy-Account-ID")
			if !validID(a.AccountID) {
				return a, fail("invalid_account_target", 400)
			}
		}
		return a, nil
	}
	if optional {
		if _, present := r.Header["X-Galaxy-Account-Id"]; !present {
			return a, nil
		}
	}
	if h.Identity == nil {
		return a, fail("account_verification_required", 401)
	}
	var e error
	a.AccountID, a.Authority, e = h.Identity.Account(r, write)
	return a, e
}
func (h AttachmentHandler) dispatch(r *http.Request, path string, parts []string, binary bool) (Object, *AttachmentContent, error) {
	f := h.Service
	if f == nil || f.Forum == nil {
		return nil, nil, fail("attachment_service_unavailable", 503)
	}
	body := func() (Object, []byte, error) {
		raw, e := readBody(r, 32768)
		if e != nil {
			return nil, nil, e
		}
		var x Object
		if json.Unmarshal(raw, &x) != nil || x == nil {
			return nil, nil, fail("invalid_request", 409)
		}
		return x, raw, nil
	}
	if path == "config" {
		x, _, e := body()
		if e != nil {
			return nil, nil, e
		}
		if len(x) != 0 {
			return nil, nil, fail("invalid_request", 409)
		}
		return f.Specification(), nil, nil
	}
	write := path == "prepare" || path == "revoke" || binary && parts[1] == "upload"
	a, e := h.actor(r, write, binary && !write)
	if e != nil {
		return nil, nil, e
	}
	if binary && write {
		length, e := strconv.ParseInt(r.Header.Get("Content-Length"), 10, 64)
		if e != nil || length < 0 || r.Header.Get("Content-Encoding") != "" || r.Header.Get("Transfer-Encoding") != "" || len(r.TransferEncoding) > 0 {
			return nil, nil, fail("attachment_length_required", 411)
		}
		out, e := f.Upload(r.Context(), a, parts[0], r.Body, length, r.Header.Get("Content-Type"), nil)
		return out, nil, e
	}
	input, raw, e := body()
	if e != nil {
		return nil, nil, e
	}
	if binary {
		input["attachmentId"] = parts[0]
		content, e := f.Content(r.Context(), a, encode(input))
		return nil, &content, e
	}
	var out Object
	switch path {
	case "prepare":
		out, e = f.Prepare(r.Context(), a, raw)
	case "read":
		out, e = f.Get(r.Context(), a, raw)
	case "query":
		out, e = f.QueryOwn(r.Context(), a, raw)
	case "revoke":
		out, e = f.Revoke(r.Context(), a, raw)
	}
	return out, nil, e
}
