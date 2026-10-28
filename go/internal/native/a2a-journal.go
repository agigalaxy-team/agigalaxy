package native

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

// The original A2A journal is separate from Native connection records. Its
// filename binds the exact JSON.stringify scope order, not sorted JSON keys.
type a2aJournalScope struct {
	SubjectID        string `json:"subjectId"`
	OfficialEndpoint string `json:"officialEndpoint"`
	Endpoint         string `json:"endpoint"`
	Tenant           string `json:"tenant"`
	PeerPrincipal    string `json:"peerPrincipal"`
}
type a2aJournal struct {
	store     *Store
	scopeHash string
}

const a2aJournalLimit = 8 * 1024 * 1024

func a2aHash(raw []byte) string { sum := sha256.Sum256(raw); return hex.EncodeToString(sum[:]) }
func newA2aJournal(store *Store, scope a2aJournalScope) (*a2aJournal, error) {
	raw, e := protocol.EncodeJS(scope)
	if e != nil {
		return nil, e
	}
	return &a2aJournal{store, a2aHash(raw)}, nil
}
func a2aError(message string) error { return errors.New("A2A: " + message) }
func (j *a2aJournal) load(dir string) (map[string]any, error) {
	f, e := os.Open(filepath.Join(dir, "a2a-"+j.scopeHash+".json"))
	if errors.Is(e, os.ErrNotExist) {
		return map[string]any{"version": 1, "scopeHash": j.scopeHash, "links": []any{}}, nil
	}
	if e != nil {
		return nil, e
	}
	defer f.Close()
	info, e := f.Stat()
	if e != nil {
		return nil, e
	}
	if info.Size() > a2aJournalLimit {
		return nil, a2aError("journal limit exceeded")
	}
	raw, e := io.ReadAll(io.LimitReader(f, info.Size()+1))
	if e != nil {
		return nil, e
	}
	if int64(len(raw)) > info.Size() || !utf8.Valid(raw) {
		return nil, a2aError("journal changed or invalid UTF-8")
	}
	value, e := a2aDecodeJSON(raw)
	data := uploadObject(value)
	if e != nil || data == nil || a2aInteger(data["version"]) != 1 || text(data["scopeHash"]) != j.scopeHash {
		return nil, a2aError("invalid journal")
	}
	links, ok := data["links"].([]any)
	if !ok || len(links) > 1000 {
		return nil, a2aError("invalid journal")
	}
	return data, nil
}
func (j *a2aJournal) list(ctx context.Context) ([]any, error) {
	var links []any
	e := j.store.With(ctx, false, func(dir string) error {
		data, e := j.load(dir)
		if e == nil {
			links = data["links"].([]any)
		}
		return e
	})
	return links, e
}
func (j *a2aJournal) get(ctx context.Context, id string) (map[string]any, error) {
	links, e := j.list(ctx)
	if e != nil {
		return nil, e
	}
	for _, item := range links {
		link := uploadObject(item)
		if text(link["id"]) == id {
			return link, nil
		}
	}
	return nil, a2aError("association not found in this scope")
}

// check runs inside the original cross-process write lock as well as at the
// call boundary. HTTP must never run inside this transaction.
func (j *a2aJournal) change(ctx context.Context, id string, revision int64, check func(string) error, update func(map[string]any) (map[string]any, error)) (map[string]any, error) {
	var result map[string]any
	e := j.store.With(ctx, true, func(dir string) error {
		if check != nil {
			if e := check(dir); e != nil {
				return e
			}
		}
		data, e := j.load(dir)
		if e != nil {
			return e
		}
		links := data["links"].([]any)
		index := -1
		var previous map[string]any
		for i, item := range links {
			candidate := uploadObject(item)
			if text(candidate["id"]) == id {
				index = i
				previous = candidate
				break
			}
		}
		if a2aInteger(previous["revision"]) != revision {
			return a2aError("association changed; refresh before retrying")
		}
		next, e := update(previous)
		if e != nil {
			return e
		}
		if next == nil || text(next["id"]) != id {
			return a2aError("invalid journal update")
		}
		if index < 0 {
			if len(links) >= 1000 {
				return a2aError("journal full")
			}
			for _, item := range links {
				old := uploadObject(item)
				if connectionEqual(old["caseId"], next["caseId"]) && connectionEqual(old["attemptId"], next["attemptId"]) {
					return a2aError("Attempt already dispatched")
				}
			}
			links = append(links, next)
		} else {
			links[index] = next
		}
		next["revision"] = revision + 1
		data["links"] = links
		// The original bound is the pretty JSON size, even though whitespace is
		// immaterial to readers. Keep that bound before atomic replacement.
		compact, e := a2aEncodeJSON(data)
		if e != nil {
			return e
		}
		var pretty bytes.Buffer
		if e = json.Indent(&pretty, compact, "", "  "); e != nil {
			return e
		}
		if pretty.Len()+1 > a2aJournalLimit {
			return a2aError("journal limit exceeded")
		}
		if e = a2aWriteJournal(filepath.Join(dir, "a2a-"+j.scopeHash+".json"), append(pretty.Bytes(), '\n')); e != nil {
			return e
		}
		result = next
		return nil
	})
	return result, e
}

func a2aWriteJournal(path string, raw []byte) error {
	f, e := os.CreateTemp(filepath.Dir(path), ".galaxy-a2a-*.tmp")
	if e != nil {
		return e
	}
	name := f.Name()
	defer os.Remove(name)
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(raw)
	}
	if e == nil {
		e = f.Sync()
	}
	closed := f.Close()
	if e != nil {
		return e
	}
	if closed != nil {
		return closed
	}
	return os.Rename(name, path)
}
