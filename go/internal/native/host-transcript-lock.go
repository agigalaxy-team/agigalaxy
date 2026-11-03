package native

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/gofrs/flock"
)

// transcriptLocks belongs to one private host connection. Lock files are
// permanent names: removing a lock file can split contenders across inodes.
type transcriptLock struct {
	owner string
	lock  *flock.Flock
}
type transcriptLocks struct {
	store *Store
	held  map[string]transcriptLock
}

func newTranscriptLocks(store *Store) *transcriptLocks {
	return &transcriptLocks{store: store, held: map[string]transcriptLock{}}
}
func (h *transcriptLocks) close() {
	for _, entry := range h.held {
		_ = entry.lock.Unlock()
	}
}
func (h *transcriptLocks) call(ctx context.Context, method string, raw json.RawMessage) (any, error) {
	in, e := hostDecode[struct {
		GalaxyID string `json:"galaxyId"`
		Key      string `json:"key"`
	}](raw)
	if e != nil {
		return nil, e
	}
	decoded, e := hex.DecodeString(in.Key)
	if e != nil || len(decoded) != 32 || in.GalaxyID == "" {
		return nil, fault.New("local_archive_transcript_lock_invalid", 400)
	}
	key := strings.ToLower(in.Key)
	owner, e := h.store.Owner(ctx)
	if e != nil {
		return nil, e
	}
	if owner == "" || owner != in.GalaxyID {
		return nil, fault.New("native_connection_selection_changed", 409)
	}
	if method == "archive.transcript.release" {
		entry, ok := h.held[key]
		if !ok || entry.owner != in.GalaxyID {
			return map[string]any{"released": false}, nil
		}
		if e = entry.lock.Unlock(); e != nil {
			return nil, e
		}
		delete(h.held, key)
		return map[string]any{"released": true}, nil
	}
	if method != "archive.transcript.acquire" {
		return nil, fault.New("native_host_method_unknown", 400)
	}
	if _, ok := h.held[key]; ok {
		return map[string]any{"acquired": false}, nil
	}
	dir := filepath.Join(h.store.Directory, "host-transcript-locks")
	if e = os.MkdirAll(dir, 0700); e != nil {
		return nil, e
	}
	lock := flock.New(filepath.Join(dir, key+".lock"))
	acquired, e := lock.TryLock()
	if e != nil {
		return nil, e
	}
	if !acquired {
		return map[string]any{"acquired": false}, nil
	}
	owner, e = h.store.Owner(ctx)
	if e != nil || owner != in.GalaxyID {
		_ = lock.Unlock()
		if e != nil {
			return nil, e
		}
		return nil, fault.New("native_connection_selection_changed", 409)
	}
	h.held[key] = transcriptLock{owner: in.GalaxyID, lock: lock}
	return map[string]any{"acquired": true}, nil
}
