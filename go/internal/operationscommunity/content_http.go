package operationscommunity

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

const contentPrefix = "/v1/operations/community/"

var contentRoute = regexp.MustCompile(`(?i)^/v1/operations/community/content/(post|reply)/(` + routeID + `)(?:/(visibility|curation))?$`)
var contentFileRoute = regexp.MustCompile(`(?i)^/v1/operations/community/content/(post|reply)/(` + routeID + `)/attachments/(` + routeID + `)/content$`)
var tagRoute = regexp.MustCompile(`(?i)^/v1/operations/community/tags/(` + routeID + `)$`)
var contentReceiptRoute = regexp.MustCompile(`(?i)^/v1/operations/community/content/(?:(post|reply)/(` + routeID + `)/)?operations/(` + routeID + `)$`)
var tagReceiptRoute = regexp.MustCompile(`(?i)^/v1/operations/community/tags/operations/(` + routeID + `)$`)

func contentMatches(p string) bool {
	return p == contentPrefix+"content" || p == contentPrefix+"tags" || p == contentPrefix+"content/visibility/preview" || p == contentPrefix+"content/visibility/batch" || contentRoute.MatchString(p) || contentFileRoute.MatchString(p) || tagRoute.MatchString(p) || contentReceiptRoute.MatchString(p) || tagReceiptRoute.MatchString(p)
}
func body(r *http.Request, max int64) (Object, error) {
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return nil, fail("unsupported_media_type", 415)
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, max+1))
	if e != nil {
		return nil, e
	}
	if int64(len(raw)) > max {
		return nil, fail("request_too_large", 413)
	}
	if !utf8.Valid(raw) || !json.Valid(raw) {
		return nil, fail("invalid_json", 409)
	}
	var x Object
	if e = protocol.Decode(raw, &x); e != nil || x == nil {
		return nil, fail("invalid_request", 409)
	}
	return x, nil
}
func query(r *http.Request, allowed ...string) (Object, error) {
	q, e := url.ParseQuery(r.URL.RawQuery)
	if e != nil {
		return nil, invalid()
	}
	x := Object{}
	for k, v := range q {
		if !has(allowed, k) || len(v) != 1 {
			return nil, invalid()
		}
		switch k {
		case "pinned", "featured":
			if v[0] != "true" && v[0] != "false" {
				return nil, invalid()
			}
			x[k] = v[0] == "true"
		case "days", "limit":
			if k == "days" && v[0] == "all" {
				x[k] = "all"
			} else {
				n, e := strconv.ParseFloat(v[0], 64)
				if e != nil {
					return nil, invalid()
				}
				x[k] = n
			}
		default:
			x[k] = v[0]
		}
	}
	return x, nil
}
func (h Handler) contentHTTP(w http.ResponseWriter, r *http.Request) {
	requestID := uuid.NewString()
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Request-ID", requestID)
	out, file, e := h.contentDispatch(r, requestID)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		out = Object{"error": fault.Code(e), "requestId": requestID}
	} else if file != nil {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.Itoa(len(file.Bytes)))
		name := strings.ReplaceAll(url.QueryEscape(file.Name), "+", "%20")
		for _, r := range []string{"!", "'", "(", ")", "*"} {
			name = strings.ReplaceAll(name, r, "%"+strings.ToUpper(strconv.FormatInt(int64(r[0]), 16)))
		}
		w.Header().Set("Content-Disposition", "attachment; filename=\"galaxy-content-attachment\"; filename*=UTF-8''"+name)
		w.Header().Set("Cache-Control", "private, no-store")
		w.Header().Set("X-Galaxy-Content-Sha256", file.SHA256)
		w.Write(file.Bytes)
		return
	}
	json.NewEncoder(w).Encode(out)
}
func (h Handler) contentDispatch(r *http.Request, requestID string) (Object, *community.AttachmentContent, error) {
	s := h.Service
	if s == nil || s.Authority == nil {
		return nil, nil, fail("business_admin_unavailable", 503)
	}
	path := r.URL.Path
	target, file, tag := contentRoute.FindStringSubmatch(path), contentFileRoute.FindStringSubmatch(path), tagRoute.FindStringSubmatch(path)
	receipt, tagReceipt := contentReceiptRoute.FindStringSubmatch(path), tagReceiptRoute.FindStringSubmatch(path)
	tags := path == contentPrefix+"tags"
	preview, batch := path == contentPrefix+"content/visibility/preview", path == contentPrefix+"content/visibility/batch"
	post := target != nil && target[3] != "" || preview || batch || tag != nil || tags && r.Method == "POST" || file != nil
	write := post && !preview && file == nil
	method := "GET"
	if post {
		method = "POST"
	}
	if r.Method != method || post && r.URL.RawQuery != "" || (receipt != nil || tagReceipt != nil) && r.URL.RawQuery != "" {
		return nil, nil, fail("not_found", 404)
	}
	code := "content.read"
	if tags || tag != nil || tagReceipt != nil {
		code = "content.tags.read"
		if write {
			code = "content.tags.manage"
		}
	} else if target != nil && target[3] == "curation" {
		code = "content.curate"
	} else if write {
		code = ""
	}
	authorize := func() (Actor, error) { return s.Authority.AuthorizeOperations(r, write || file != nil, code) }
	a, e := authorize()
	if e != nil {
		return nil, nil, e
	}
	a.RequestID = &requestID
	ctx := r.Context()
	if receipt != nil || tagReceipt != nil {
		family, kind, id, op := "tag", "", "", ""
		if receipt != nil {
			family, kind, id, op = "content", receipt[1], receipt[2], receipt[3]
			if kind == "" {
				family = "batch"
			}
		} else {
			op = tagReceipt[1]
		}
		v, e := s.ContentCommandResult(ctx, a, family, kind, id, op)
		return v, nil, e
	}
	if file != nil {
		x, e := body(r, 32768)
		if e != nil {
			return nil, nil, e
		}
		if len(x) != 0 {
			return nil, nil, fail("invalid_request", 409)
		}
		v, e := s.ContentAttachment(ctx, a, file[1], file[2], file[3], authorize)
		return nil, &v, e
	}
	var out Object
	if !post {
		switch {
		case path == contentPrefix+"content":
			x, e := query(r, "query", "targetId", "kind", "topic", "visibility", "pinned", "featured", "days", "after", "limit")
			if e != nil {
				return nil, nil, e
			}
			out, e = s.Contents(ctx, a, x)
		case target != nil:
			x, e := query(r, "historyAfter")
			if e != nil {
				return nil, nil, e
			}
			out, e = s.Content(ctx, a, target[1], target[2], x)
		default:
			if r.URL.RawQuery != "" {
				return nil, nil, invalid()
			}
			out, e = s.Tags(ctx, a)
		}
		return out, nil, e
	}
	x, e := body(r, 32768)
	if e != nil {
		return nil, nil, e
	}
	switch {
	case target != nil:
		if target[3] == "curation" {
			out, e = s.Curate(ctx, a, target[1], target[2], x)
		} else {
			out, e = s.ContentVisibility(ctx, a, target[1], target[2], x)
		}
	case preview:
		out, e = s.Preview(ctx, a, x)
	case batch:
		out, e = s.Batch(ctx, a, x)
	default:
		id := ""
		if tag != nil {
			id = tag[1]
		}
		out, e = s.Tag(ctx, a, id, x)
	}
	return out, nil, e
}
