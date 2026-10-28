package native

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

// This is the original trusted menu reset, not an MCP operation. Its fixed
// filenames are code-owned; neither Host parameters nor the journal can select
// paths. The separate retained material areas are deliberately not traversed.
func (s *Store) resetLocalIntegration(ctx context.Context) (map[string]any, error) {
	var out map[string]any
	e := s.With(ctx, true, func(dir string) error {
		markerPath := filepath.Join(dir, ".galaxy-reset.json")
		var raw json.RawMessage
		present, e := readJSON(markerPath, &raw)
		if e != nil {
			return e
		}
		if present && string(raw) != "null" {
			value, e := protocol.DecodeOrdered(raw)
			if e != nil {
				return e
			}
			marker, ok := value.(*protocol.OrderedObject)
			if !ok {
				return connectionFailure("local_reset_journal_invalid")
			}
			keys := marker.Keys()
			if len(keys) != 2 || keys[0] != "version" || keys[1] != "operation" || marker.Values()["operation"] != "reset" {
				return connectionFailure("local_reset_journal_invalid")
			}
			number, ok := marker.Values()["version"].(json.Number)
			if !ok {
				return connectionFailure("local_reset_journal_invalid")
			}
			version, e := number.Float64()
			if e != nil || version != 1 {
				return connectionFailure("local_reset_journal_invalid")
			}
		} else {
			marker := protocol.NewOrderedObject()
			marker.Set("version", 1)
			marker.Set("operation", "reset")
			if e = writeJSON(markerPath, marker); e != nil {
				return e
			}
		}
		names := []string{".galaxy-initialization.json", "galaxy-id.json", "galaxy-id-private-key.pem", "galaxy-id-public-key.pem", "galaxy-local-state.json", "node.json", "node-private-key.pem", "node-public-key.pem", "local-state.json"}
		removeFile := func(name string) error {
			if e := ctx.Err(); e != nil {
				return e
			}
			target := filepath.Join(dir, name)
			info, e := os.Lstat(target)
			if errors.Is(e, os.ErrNotExist) {
				return nil
			}
			if e != nil {
				return e
			}
			if info.IsDir() {
				return connectionFailure("local_reset_target_invalid")
			}
			e = os.Remove(target)
			if errors.Is(e, os.ErrNotExist) {
				return nil
			}
			return e
		}
		for _, name := range names {
			if e = removeFile(name); e != nil {
				return e
			}
		}
		if e = removeFile(".galaxy-reset.json"); e != nil {
			return e
		}
		out = map[string]any{"dataDir": dir, "removedFiles": append(names, ".galaxy-reset.json"), "retainedLocalAreas": []string{"work-history", "conversation-archive", "native-v2", "workers", "galaxy-upload-privacy.json"}, "message": "Reset removes the listed local identity/configuration files. Separate work history, private conversation archives, Native records and Worker directories remain in their original locations. Export or delete owned work/archives through their dedicated tools before resetting if needed.", "localOnly": true}
		return nil
	})
	return out, e
}
