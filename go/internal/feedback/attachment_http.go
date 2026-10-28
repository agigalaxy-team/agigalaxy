package feedback

import (
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

var lengthPattern = regexp.MustCompile(`^[0-9]+$`)

func (h Handler) attachmentHTTP(w http.ResponseWriter, r *http.Request, p []string, account bool, requestID string) bool {
	draft := account && len(p) >= 3 && p[2] == "attachments"
	content := !account && len(p) == 6 && p[3] == "attachments" && p[5] == "content" && uuidPattern.MatchString(p[2]) && uuidPattern.MatchString(p[4])
	if !draft && !content {
		return false
	}
	if account && len(p) == 5 && p[4] == "upload" {
		controller := http.NewResponseController(w)
		_ = controller.SetReadDeadline(time.Now().Add(60 * time.Second))
		defer controller.SetReadDeadline(time.Time{})
	}
	writeError := func(e error) {
		status := fault.Status(e)
		if fault.Code(e) == "internal_error" {
			status = 500
		}
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(Object{"error": fault.Code(e), "requestId": requestID})
	}
	out, file, e := h.dispatchAttachment(r, p, account, requestID)
	if e != nil {
		writeError(e)
		return true
	}
	if file != nil {
		writeAttachmentContent(w, *file)
		return true
	}
	w.WriteHeader(200)
	_ = json.NewEncoder(w).Encode(out)
	return true
}

func writeAttachmentContent(w http.ResponseWriter, file AttachmentContent) {
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.Itoa(len(file.Bytes)))
	name := url.PathEscape(file.Name)
	name = strings.ReplaceAll(name, "+", "%2B")
	for _, c := range []string{"!", "'", "(", ")", "*"} {
		name = strings.ReplaceAll(name, c, "%"+strings.ToUpper(strconv.FormatInt(int64(c[0]), 16)))
	}
	w.Header().Set("Content-Disposition", "attachment; filename=\"galaxy-feedback-attachment\"; filename*=UTF-8''"+name)
	w.Header().Set("X-Galaxy-Content-Sha256", file.SHA256)
	w.WriteHeader(200)
	_, _ = w.Write(file.Bytes)
}
func (h Handler) dispatchAttachment(r *http.Request, p []string, account bool, requestID string) (Object, *AttachmentContent, error) {
	missing := func() (Object, *AttachmentContent, error) { return nil, nil, fault.New("not_found", 404) }
	upload := account && len(p) == 5 && p[4] == "upload" && uuidPattern.MatchString(p[3])
	if r.URL.RawQuery != "" || upload && r.Method != "PUT" || !upload && r.Method != "POST" {
		return missing()
	}
	if account && !upload && (len(p) != 4 || p[3] != "config" && p[3] != "prepare" && p[3] != "read" && p[3] != "revoke") {
		return missing()
	}
	if h.Service == nil {
		return nil, nil, fault.New("attachment_service_unavailable", 503)
	}
	if h.Identity == nil {
		if account {
			return nil, nil, fault.New("official_account_unavailable", 503)
		}
		return nil, nil, fault.New("business_admin_unavailable", 503)
	}
	s := *h.Service
	s.RequestID = requestID
	if !account {
		operator, authority, e := h.Identity.Operator(r, true, "feedback.attachments.read")
		if e != nil {
			return nil, nil, e
		}
		s.Authority = authority
		raw, e := body(r, 65536)
		if e != nil {
			return nil, nil, e
		}
		var empty map[string]any
		if json.Unmarshal(raw, &empty) != nil || len(empty) != 0 {
			return nil, nil, fault.New("invalid_request", 400)
		}
		file, e := s.AttachmentContent(r.Context(), operator, p[2], p[4], func() error {
			current, _, e := h.Identity.Operator(r, true, "feedback.attachments.read")
			if e == nil && current != operator {
				return fault.New("business_admin_denied", 403)
			}
			return e
		})
		return nil, &file, e
	}
	if _, ok := r.Header["Authorization"]; ok {
		return nil, nil, fault.New("official_account_login_required", 401)
	}
	subject, authority, e := h.Identity.Account(r, true)
	if e != nil {
		return nil, nil, e
	}
	s.Authority = authority
	if upload {
		if r.Header.Get("Content-Encoding") != "" || len(r.TransferEncoding) > 0 || !lengthPattern.MatchString(r.Header.Get("Content-Length")) {
			return nil, nil, fault.New("attachment_length_required", 411)
		}
		length, e := strconv.ParseInt(r.Header.Get("Content-Length"), 10, 64)
		if e != nil {
			return nil, nil, fault.New("attachment_length_required", 411)
		}
		out, e := s.AttachmentUpload(r.Context(), subject, p[3], r.Body, length, r.Header.Get("Content-Type"))
		return out, nil, e
	}
	raw, e := body(r, 4096)
	if e != nil {
		return nil, nil, e
	}
	var out Object
	switch p[3] {
	case "config":
		var m map[string]any
		if json.Unmarshal(raw, &m) != nil || len(m) != 0 {
			return nil, nil, fault.New("invalid_request", 400)
		}
		out, e = s.AttachmentConfig(r.Context(), subject)
	case "prepare":
		out, e = s.AttachmentPrepare(r.Context(), subject, raw)
	case "read", "revoke":
		out, e = s.AttachmentTarget(r.Context(), subject, raw, p[3] == "revoke")
	}
	return out, nil, e
}
