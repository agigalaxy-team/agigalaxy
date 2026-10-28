package publication

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

type Object = map[string]any
type Snapshot struct{ value Object }

func (s Snapshot) Value() Object                { return s.value }
func (s Snapshot) MarshalJSON() ([]byte, error) { return json.Marshal(s.value) }
func ParseSnapshot(raw []byte) (Snapshot, error) {
	var value Object
	if len(raw) > 1048576 || protocol.Decode(raw, &value) != nil || !validSnapshot(value) {
		return Snapshot{}, fault.New("invalid_site_publication", 400)
	}
	return Snapshot{value}, nil
}
func object(v any) (Object, bool) { o, ok := v.(map[string]any); return o, ok }
func exact(o Object, required, optional []string) bool {
	if o == nil {
		return false
	}
	for _, k := range required {
		if _, ok := o[k]; !ok {
			return false
		}
	}
	for k := range o {
		found := false
		for _, v := range append(append([]string{}, required...), optional...) {
			if k == v {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
func text(v any, min, max int) bool {
	s, ok := v.(string)
	if !ok || utf8.RuneCountInString(s) < min || utf8.RuneCountInString(s) > max {
		return false
	}
	for _, r := range s {
		if r <= 8 || r == 11 || r == 12 || r >= 14 && r <= 31 {
			return false
		}
	}
	return true
}
func jsSpace(r rune) bool {
	return r >= 9 && r <= 13 || r == 32 || r == 0xa0 || r == 0x1680 || r >= 0x2000 && r <= 0x200a || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff
}
func safeHref(v any) bool {
	s, ok := v.(string)
	if !ok || utf8.RuneCountInString(s) > 2048 {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) || jsSpace(r) || r == '\\' {
			return false
		}
	}
	if strings.HasPrefix(s, "/") && !strings.HasPrefix(s, "//") {
		return true
	}
	u, e := url.Parse(s)
	return e == nil && u.Scheme == "https" && u.Host != "" && u.User == nil
}
func integer(v any, min, max int64) bool {
	n, ok := v.(json.Number)
	if !ok {
		return false
	}
	f, e := n.Float64()
	return e == nil && !math.IsInf(f, 0) && math.Trunc(f) == f && f >= float64(min) && f <= float64(max)
}
func links(v any, limit int, description bool) bool {
	items, ok := v.([]any)
	if !ok || len(items) > limit {
		return false
	}
	for _, item := range items {
		o, ok := object(item)
		optional := []string{}
		if description {
			optional = []string{"description"}
		}
		if !ok || !exact(o, []string{"label", "href"}, optional) || !text(o["label"], 1, 120) || !safeHref(o["href"]) {
			return false
		}
		if d, ok := o["description"]; ok && !text(d, 0, 400) {
			return false
		}
	}
	return true
}

var pagePath = regexp.MustCompile(`^/(?:[a-z0-9]+(?:-[a-z0-9]+)*/)*$`)

func validSnapshot(v Object) bool {
	if !exact(v, []string{"version", "settings", "pages", "media"}, nil) || !integer(v["version"], 1, 1) {
		return false
	}
	settings, ok := object(v["settings"])
	if !ok || !validSettings(settings) {
		return false
	}
	media, ok := v["media"].([]any)
	if !ok || len(media) > 1000 {
		return false
	}
	ids := map[string]bool{}
	for _, item := range media {
		m, ok := object(item)
		if !ok || !exact(m, []string{"id", "url", "filename", "alt", "mimeType", "filesize"}, []string{"width", "height", "credit"}) || !text(m["id"], 1, 128) || !text(m["url"], 1, 2048) || !text(m["filename"], 1, 255) || !text(m["alt"], 0, 1000) || !integer(m["filesize"], 0, 20971520) {
			return false
		}
		id := m["id"].(string)
		if ids[id] {
			return false
		}
		ids[id] = true
		filename := m["filename"].(string)
		if filename == "." || filename == ".." || strings.ContainsAny(filename, "/\\") {
			return false
		}
		for _, r := range filename {
			if unicode.IsControl(r) {
				return false
			}
		}
		mime, _ := m["mimeType"].(string)
		if mime != "image/jpeg" && mime != "image/png" && mime != "image/gif" && mime != "image/webp" && mime != "image/avif" {
			return false
		}
		for _, k := range []string{"width", "height"} {
			if n, present := m[k]; present && n != nil && !integer(n, 1, 9007199254740991) {
				return false
			}
		}
		if credit, present := m["credit"]; present && !text(credit, 0, 2000) {
			return false
		}
	}
	pages, ok := v["pages"].([]any)
	if !ok || len(pages) > 200 {
		return false
	}
	paths := map[string]bool{}
	for _, item := range pages {
		p, ok := object(item)
		if !ok || !exact(p, []string{"id", "path", "title", "description", "blocks", "updatedAt"}, nil) || !text(p["id"], 1, 128) || !text(p["title"], 1, 200) || !text(p["description"], 0, 1600) {
			return false
		}
		path, ok := p["path"].(string)
		if !ok || len(path) > 300 || !pagePath.MatchString(path) || paths[path] {
			return false
		}
		paths[path] = true
		for _, reserved := range []string{"/admin", "/api", "/app", "/v1", "/v2", "/preview", "/assets", "/media", "/releases", "/archives"} {
			if path == reserved || strings.HasPrefix(path, reserved+"/") {
				return false
			}
		}
		date, ok := p["updatedAt"].(string)
		if !ok || strings.Contains(date, ",") {
			return false
		}
		if _, e := time.Parse(time.RFC3339Nano, date); e != nil {
			return false
		}
		blocks, ok := p["blocks"].([]any)
		if !ok || len(blocks) > 100 {
			return false
		}
		for _, value := range blocks {
			b, ok := object(value)
			if !ok || !validBlock(b, ids) {
				return false
			}
		}
	}
	return true
}
func validSettings(settings Object) bool {
	return exact(settings, []string{"siteTitle", "description", "footerLinks"}, nil) && text(settings["siteTitle"], 1, 200) && text(settings["description"], 0, 1600) && links(settings["footerLinks"], 24, false)
}

// ParseSettings is the original snapshot.settings schema, without requiring
// unrelated media/page fields merely to read published general settings.
func ParseSettings(settings Object) (Object, error) {
	if !validSettings(settings) {
		return nil, fault.New("invalid_site_publication", 400)
	}
	return settings, nil
}
func validBlock(b Object, ids map[string]bool) bool {
	kind, _ := b["blockType"].(string)
	var required, optional []string
	switch kind {
	case "hero":
		required = []string{"blockType", "heading", "text", "links"}
	case "prose":
		required = []string{"blockType", "body"}
		optional = []string{"heading"}
	case "linkList":
		required = []string{"blockType", "links"}
		optional = []string{"heading"}
	case "image":
		required = []string{"blockType", "mediaId", "caption"}
	case "notice":
		required = []string{"blockType", "tone", "title", "text"}
	case "releaseLinks":
		required = []string{"blockType", "channel", "label"}
		optional = []string{"heading"}
	default:
		return false
	}
	if !exact(b, required, optional) {
		return false
	}
	if heading, ok := b["heading"]; ok {
		min := 0
		if kind == "hero" {
			min = 1
		}
		if !text(heading, min, 200) {
			return false
		}
	}
	switch kind {
	case "hero":
		return text(b["text"], 0, 1600) && links(b["links"], 12, true)
	case "prose":
		return text(b["body"], 0, 30000)
	case "linkList":
		return links(b["links"], 12, true)
	case "image":
		id, ok := b["mediaId"].(string)
		return ok && text(id, 1, 128) && ids[id] && text(b["caption"], 0, 800)
	case "notice":
		return (b["tone"] == "information" || b["tone"] == "service-impact") && text(b["title"], 1, 200) && text(b["text"], 0, 4000)
	case "releaseLinks":
		return b["channel"] == "stable" && text(b["label"], 1, 120)
	}
	return false
}
func encode(v any) ([]byte, error) {
	b, e := protocol.Encode(v)
	if e != nil {
		return nil, e
	}
	return append(b, '\n'), nil
}
func decodeObject(raw []byte) (Object, error) {
	var out Object
	e := protocol.Decode(bytes.TrimSpace(raw), &out)
	if e != nil || out == nil {
		return nil, fmt.Errorf("invalid publication object")
	}
	return out, nil
}
