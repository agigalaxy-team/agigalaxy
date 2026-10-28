package native

import (
	"context"
	"path/filepath"
)

// OpenCode's existing first-start preference follows the same selected public
// configuration as its identity; the host never guesses a second data folder.
func (s *Store) OpenCodePreparationStatus(ctx context.Context) (map[string]any, error) {
	deferred := false
	e := s.With(ctx, false, func(dir string) error {
		var record map[string]any
		_, e := readJSON(filepath.Join(dir, "opencode-local-preparation.json"), &record)
		if e != nil {
			return e
		}
		deferred = record["deferred"] == true
		return nil
	})
	return map[string]any{"deferred": deferred}, e
}
func (s *Store) SetOpenCodePreparationDeferred(ctx context.Context, deferred bool) error {
	return s.With(ctx, true, func(dir string) error {
		return writeJSON(filepath.Join(dir, "opencode-local-preparation.json"), map[string]any{"version": 1, "deferred": deferred})
	})
}
