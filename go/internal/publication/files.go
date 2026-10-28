package publication

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
)

const marker = "cms-publication.json"

type Config struct {
	Version          int             `json:"version"`
	Endpoint         string          `json:"endpoint"`
	PublicOrigin     string          `json:"publicOrigin"`
	AdminOrigin      string          `json:"adminOrigin"`
	BaseDirectory    string          `json:"baseDirectory"`
	ReleaseDirectory string          `json:"releaseDirectory"`
	CurrentLink      string          `json:"currentLink"`
	MediaDirectory   string          `json:"mediaDirectory"`
	Renderer         json.RawMessage `json:"renderer,omitempty"`
	Python           json.RawMessage `json:"python,omitempty"`
}

func LoadConfiguration(path string) (Config, error) {
	var c Config
	b, e := regularBytes(path, 16384)
	if e != nil {
		return c, fault.New("site_publication_configuration_invalid", 400)
	}
	info, e := os.Lstat(path)
	if e != nil || runtime.GOOS != "windows" && info.Mode().Perm()&0022 != 0 || protocol.Decode(b, &c) != nil || c.Version != 1 {
		return c, fault.New("site_publication_configuration_invalid", 400)
	}
	for _, origin := range []string{c.Endpoint, c.PublicOrigin, c.AdminOrigin} {
		if !exactOrigin(origin) {
			return c, fault.New("site_publication_configuration_invalid", 400)
		}
		u, e := url.Parse(origin)
		if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || "https://"+strings.ToLower(u.Host) != origin {
			return c, fault.New("site_publication_configuration_invalid", 400)
		}
	}
	for _, path := range []string{c.BaseDirectory, c.ReleaseDirectory, c.CurrentLink, c.MediaDirectory} {
		if !filepath.IsAbs(path) {
			return c, fault.New("site_publication_configuration_invalid", 400)
		}
	}
	return c, nil
}

type Filesystem struct {
	config                        Config
	base, releases, media, parent string
	Now                           func() time.Time
}
type Artifact struct{ PublicationID, SiteVersion, Directory string }
type Current struct{ PublicationID, SiteVersion string }

func inside(root, path string) bool {
	part, e := filepath.Rel(root, path)
	return e == nil && part != "." && part != ".." && !strings.HasPrefix(part, ".."+string(filepath.Separator)) && !filepath.IsAbs(part)
}
func directory(path string) (string, error) {
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("absolute publisher directory required")
	}
	info, e := os.Lstat(path)
	if e != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("publisher directory required")
	}
	return filepath.EvalSymlinks(path)
}
func regularBytes(path string, max int64) ([]byte, error) {
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("absolute publisher file required")
	}
	info, e := os.Lstat(path)
	if e != nil || !info.Mode().IsRegular() || info.Size() > max {
		return nil, fmt.Errorf("publisher regular file required")
	}
	f, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	current, e := f.Stat()
	if e != nil || !os.SameFile(info, current) {
		return nil, fmt.Errorf("publisher file changed")
	}
	b, e := io.ReadAll(io.LimitReader(f, max+1))
	if e != nil || int64(len(b)) > max {
		return nil, fmt.Errorf("publisher file too large")
	}
	return b, nil
}
func NewFilesystem(c Config) (*Filesystem, error) {
	base, e := directory(c.BaseDirectory)
	if e != nil {
		return nil, e
	}
	releases, e := directory(c.ReleaseDirectory)
	if e != nil {
		return nil, e
	}
	media, e := directory(c.MediaDirectory)
	if e != nil {
		return nil, e
	}
	if base == releases || inside(base, releases) || inside(base, c.CurrentLink) {
		return nil, fmt.Errorf("separate publisher source and output required")
	}
	parent, e := filepath.EvalSymlinks(filepath.Dir(c.CurrentLink))
	if e != nil {
		return nil, e
	}
	return &Filesystem{config: c, base: base, releases: releases, media: media, parent: parent}, nil
}
func (f *Filesystem) Current(ctx context.Context) (*Current, error) {
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	info, e := os.Lstat(f.config.CurrentLink)
	if errors.Is(e, os.ErrNotExist) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	if info.Mode()&os.ModeSymlink == 0 {
		return nil, fmt.Errorf("website pointer must be a symbolic link")
	}
	path, e := filepath.EvalSymlinks(f.config.CurrentLink)
	if e != nil {
		return nil, e
	}
	if !inside(f.releases, path) {
		return nil, fmt.Errorf("website pointer escaped release directory")
	}
	b, e := regularBytes(filepath.Join(path, marker), 4096)
	if e != nil {
		return nil, e
	}
	value, e := decodeObject(b)
	if e != nil {
		return nil, e
	}
	if integer(value["version"], 1, 1) && value["mode"] == "baseline" && value["publicationId"] == nil && hasKey(value, "publicationId") {
		return nil, nil
	}
	id, _ := value["publicationId"].(string)
	if !integer(value["version"], 1, 1) || !uuidValid(id) {
		return nil, fmt.Errorf("invalid active publication marker")
	}
	if mode, ok := value["mode"]; ok && mode != "published" {
		return nil, fmt.Errorf("invalid active publication mode")
	}
	version, _ := value["siteVersion"].(string)
	return &Current{id, version}, nil
}
func uuidValid(id string) bool {
	v, e := uuid.Parse(id)
	return e == nil && strings.EqualFold(v.String(), id)
}
func (f *Filesystem) Prepare(ctx context.Context, id string, snapshot Snapshot) (Artifact, error) {
	if e := ctx.Err(); e != nil {
		return Artifact{}, e
	}
	if !uuidValid(id) {
		return Artifact{}, fmt.Errorf("invalid publication reference")
	}
	raw, e := json.Marshal(snapshot)
	if e != nil {
		return Artifact{}, e
	}
	parsed, e := ParseSnapshot(raw)
	if e != nil {
		return Artifact{}, e
	}
	value := parsed.value
	temporary := filepath.Join(f.releases, ".cms-"+id+"-"+uuid.NewString())
	if e = os.Mkdir(temporary, 0750); e != nil {
		return Artifact{}, e
	}
	selectedMedia := filepath.Join(temporary, "media")
	if e = os.Mkdir(selectedMedia, 0750); e != nil {
		return Artifact{}, e
	}
	selected := map[string]bool{}
	for _, page := range value["pages"].([]any) {
		for _, block := range page.(map[string]any)["blocks"].([]any) {
			b := block.(map[string]any)
			if b["blockType"] == "image" {
				selected[b["mediaId"].(string)] = true
			}
		}
	}
	copied := map[string]bool{}
	publicMedia := []any{}
	for _, item := range value["media"].([]any) {
		m := item.(map[string]any)
		mediaID := m["id"].(string)
		if !selected[mediaID] {
			continue
		}
		if e = ctx.Err(); e != nil {
			return Artifact{}, e
		}
		reference, e := url.Parse(m["url"].(string))
		if e != nil {
			return Artifact{}, e
		}
		origin, _ := url.Parse(f.config.AdminOrigin)
		reference = origin.ResolveReference(reference)
		if reference.Scheme+"://"+reference.Host != f.config.AdminOrigin || reference.RawQuery != "" || reference.Fragment != "" || !strings.HasPrefix(reference.Path, "/api/media/file/") {
			return Artifact{}, fmt.Errorf("CMS media origin changed")
		}
		filename := strings.TrimPrefix(reference.Path, "/api/media/file/")
		if filename != m["filename"] || strings.ContainsAny(filename, "/\\") {
			return Artifact{}, fmt.Errorf("CMS media reference changed")
		}
		source := filepath.Join(f.media, filename)
		bytes, e := regularBytes(source, 21000000)
		if e != nil {
			return Artifact{}, e
		}
		size, _ := m["filesize"].(json.Number).Float64()
		resolved, e := filepath.EvalSymlinks(source)
		if e != nil || !inside(f.media, resolved) || float64(len(bytes)) != size {
			return Artifact{}, fmt.Errorf("CMS media no longer matches selected file")
		}
		if !copied[filename] {
			if e = exclusiveWrite(filepath.Join(selectedMedia, filename), bytes, 0640); e != nil {
				return Artifact{}, e
			}
			copied[filename] = true
		}
		m["url"] = "/media/cms/" + component(mediaID) + "/" + component(filename)
		publicMedia = append(publicMedia, m)
	}
	value["media"] = publicMedia
	b, e := encode(value)
	if e != nil {
		return Artifact{}, e
	}
	if e = exclusiveWrite(filepath.Join(temporary, "cms-snapshot.json"), b, 0640); e != nil {
		return Artifact{}, e
	}
	softwareBytes, e := regularBytes(filepath.Join(f.base, "release.json"), 65536)
	if e != nil {
		return Artifact{}, e
	}
	software, e := decodeObject(softwareBytes)
	if e != nil {
		return Artifact{}, e
	}
	version, ok := software["version"].(string)
	if !ok || version == "" {
		return Artifact{}, fmt.Errorf("software version required")
	}
	if e = ctx.Err(); e != nil {
		return Artifact{}, e
	}
	now := time.Now()
	if f.Now != nil {
		now = f.Now()
	}
	b, e = encode(Object{"version": 1, "mode": "published", "publicationId": id, "siteVersion": version, "createdAt": now.UTC().Format("2006-01-02T15:04:05.000Z")})
	if e != nil {
		return Artifact{}, e
	}
	if e = exclusiveWrite(filepath.Join(temporary, marker), b, 0640); e != nil {
		return Artifact{}, e
	}
	return Artifact{id, version, temporary}, nil
}
func (f *Filesystem) Activate(ctx context.Context, artifact Artifact) error {
	if e := ctx.Err(); e != nil {
		return e
	}
	candidate, e := directory(artifact.Directory)
	if e != nil {
		return e
	}
	if !inside(f.releases, candidate) || !uuidValid(artifact.PublicationID) {
		return fmt.Errorf("publication escaped release directory")
	}
	b, e := regularBytes(filepath.Join(candidate, marker), 4096)
	if e != nil {
		return e
	}
	recorded, e := decodeObject(b)
	if e != nil || recorded["publicationId"] != artifact.PublicationID {
		return fmt.Errorf("publication reference changed")
	}
	b, e = regularBytes(filepath.Join(candidate, "cms-snapshot.json"), 1048576)
	if e != nil {
		return e
	}
	if _, e = ParseSnapshot(b); e != nil {
		return e
	}
	if info, e := os.Lstat(f.config.CurrentLink); e == nil && info.Mode()&os.ModeSymlink == 0 {
		return fmt.Errorf("website pointer must be a symbolic link")
	} else if e != nil && !errors.Is(e, os.ErrNotExist) {
		return e
	}
	link := filepath.Join(f.parent, ".website-next-"+uuid.NewString())
	relative, e := filepath.Rel(f.parent, candidate)
	if e != nil {
		return e
	}
	if e = os.Symlink(relative, link); e != nil {
		return e
	}
	if e = os.Rename(link, f.config.CurrentLink); e != nil {
		os.Remove(link)
		return e
	}
	return nil
}
func exclusiveWrite(path string, b []byte, mode os.FileMode) error {
	f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if e != nil {
		return e
	}
	_, e = f.Write(b)
	closed := f.Close()
	if e != nil {
		return e
	}
	return closed
}
func component(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for _, c := range []byte(s) {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("-_.!~*'()", rune(c)) {
			b.WriteByte(c)
		} else {
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&15])
		}
	}
	return b.String()
}

func hasKey(value Object, key string) bool { _, ok := value[key]; return ok }

func exactOrigin(value string) bool {
	u, e := url.Parse(value)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || strings.HasSuffix(u.Host, ":") {
		return false
	}
	for _, r := range u.Host {
		if r > 127 {
			return false
		}
	}
	if port := u.Port(); port != "" {
		n, e := strconv.Atoi(port)
		if e != nil || n < 0 || n > 65535 || n == 443 || strconv.Itoa(n) != port {
			return false
		}
	}
	return "https://"+strings.ToLower(u.Host) == value
}
