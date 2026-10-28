package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

func localSnapshotWithin(dir string) (map[string]any, error) {
	for _, name := range []string{".galaxy-initialization.json", ".galaxy-reset.json"} {
		if present, e := exists(filepath.Join(dir, name)); e != nil {
			return nil, e
		} else if present {
			return map[string]any{"dataDir": dir, "identity": nil, "state": initializationState(), "recoveryRequired": true}, nil
		}
	}
	var identity, state map[string]any
	if e := readFallback(dir, "galaxy-id.json", "node.json", &identity); e != nil {
		return nil, e
	}
	if e := readFallback(dir, "galaxy-local-state.json", "local-state.json", &state); e != nil {
		return nil, e
	}
	return map[string]any{"dataDir": dir, "identity": identity, "state": initializationNormalize(state)}, nil
}
func (s *Store) LocalSnapshot(ctx context.Context) (map[string]any, error) {
	var result map[string]any
	e := s.With(ctx, false, func(dir string) error { var e error; result, e = localSnapshotWithin(dir); return e })
	return result, e
}
func (s *Store) LocalStatus(ctx context.Context) (any, error) {
	snapshot, e := s.LocalSnapshot(ctx)
	if e != nil {
		return nil, e
	}
	state := uploadObject(snapshot["state"])
	return map[string]any{"dataDir": snapshot["dataDir"], "identity": snapshot["identity"], "recoveryRequired": snapshot["recoveryRequired"] == true, "counts": map[string]any{"cases": len(uploadRows(state["cases"])), "disclosurePlans": len(uploadRows(state["disclosurePlans"])), "consentGrants": len(uploadRows(state["consentGrants"])), "localProofDrafts": len(uploadRows(state["localProofDrafts"]))}}, nil
}
func (s *Store) ExportLocalData(ctx context.Context) (any, error) {
	snapshot, e := s.LocalSnapshot(ctx)
	if e != nil {
		return nil, e
	}
	return map[string]any{"exportVersion": 2, "exportedAt": localNow(), "localOnly": true, "identity": snapshot["identity"], "recoveryRequired": snapshot["recoveryRequired"] == true, "state": snapshot["state"], "excluded": []string{"galaxy-id-private-key.pem", "raw source files", "environment variables", "tokens", "credentials"}}, nil
}
func initializeBareWithin(dir, subject, kind string) (map[string]any, error) {
	if present, e := exists(filepath.Join(dir, ".galaxy-reset.json")); e != nil {
		return nil, e
	} else if present {
		return nil, fault.New("local_initialization_requires_recovery", 409)
	}
	if e := initializationMigrate(dir); e != nil {
		return nil, e
	}
	if e := initializationResume(dir); e != nil {
		return nil, e
	}
	var local map[string]any
	if _, e := readJSON(filepath.Join(dir, "galaxy-id.json"), &local); e != nil {
		return nil, e
	}
	if local != nil {
		if subject != "" && local["subjectType"] != subject {
			code := "local_identity_type_immutable"
			if text(local["subjectType"]) == "" {
				code = "local_identity_legacy_type_unconfirmed"
			}
			return nil, fault.New(code, 409)
		}
		if current := text(local["clientKind"]); current != "" && current != kind {
			return nil, fault.New("local_identity_client_kind_mismatch", 409)
		}
	} else {
		for _, name := range []string{"galaxy-id-private-key.pem", "galaxy-id-public-key.pem", "galaxy-local-state.json"} {
			if present, e := exists(filepath.Join(dir, name)); e != nil {
				return nil, e
			} else if present {
				return nil, fault.New("local_initialization_incomplete", 409)
			}
		}
		selectedSubject := subject
		if selectedSubject == "" {
			selectedSubject = "person"
		}
		record, e := initializationNew(selectedSubject)
		if e != nil {
			return nil, e
		}
		if kind == "worker" {
			var value map[string]any
			if e = protocol.Decode(record.Identity, &value); e != nil {
				return nil, e
			}
			value["clientKind"] = "worker"
			raw, e := protocol.Encode(value)
			if e != nil {
				return nil, e
			}
			record.Identity = raw
		}
		if e = initializationPublish(dir, record); e != nil {
			return nil, e
		}
		if _, e = readJSON(filepath.Join(dir, "galaxy-id.json"), &local); e != nil {
			return nil, e
		}
	}
	var state map[string]any
	present, e := readJSON(filepath.Join(dir, "galaxy-local-state.json"), &state)
	if e != nil {
		return nil, e
	}
	if !present {
		state = initializationState()
		initializationAudit(state, "galaxy_id.initialized", text(local["id"]), initializationTime(), map[string]any{"localOnly": true})
		if e = writeJSON(filepath.Join(dir, "galaxy-local-state.json"), state); e != nil {
			return nil, e
		}
	} else {
		before := identityClone(state)
		state = initializationNormalize(state)
		if !connectionEqual(before, state) {
			if e = writeJSON(filepath.Join(dir, "galaxy-local-state.json"), state); e != nil {
				return nil, e
			}
		}
	}
	return map[string]any{"dataDir": dir, "identity": local, "state": state}, nil
}

// InitializeLocalIdentity is the existing internal fallback, without enabling
// integration modules or a Native device connection. A selected imported ID is
// never used as a reason to create a replacement local genesis.
func (s *Store) InitializeLocalIdentity(ctx context.Context, subject string, confirmed bool, scope *ChoiceScope) (any, error) {
	if !confirmed {
		return nil, fault.New("local_initialization_choice_required", 403)
	}
	if subject != "" && !isOne(subject, "person", "organization") {
		return nil, fault.New("local_identity_subject_type_invalid", 400)
	}
	var result any
	e := s.With(ctx, true, func(dir string) error {
		if scope != nil {
			if e := s.verifyChoiceWithin(dir, scope); e != nil {
				return e
			}
		}
		var local map[string]any
		if e := readFallback(dir, "galaxy-id.json", "node.json", &local); e != nil {
			return e
		}
		if s.Endpoint != "" {
			selection, e := runtimeRecordWithin(dir, s.Endpoint)
			if e != nil {
				return e
			}
			active := uploadObject(selection["active"])
			if active != nil && active["subjectId"] != local["id"] {
				return fault.New("local_identity_already_adopted", 409)
			}
		}
		var e error
		result, e = initializeBareWithin(dir, subject, "normal")
		return e
	})
	return result, e
}

var workerLocalID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`)

func (s *Store) InitializeWorkerIdentity(ctx context.Context, workerID string, confirmed bool, scope *ChoiceScope) (any, error) {
	if !confirmed {
		return nil, fault.New("local_initialization_choice_required", 403)
	}
	if !workerLocalID.MatchString(workerID) {
		return nil, fault.New("local_worker_id_invalid", 400)
	}
	if scope == nil {
		return nil, fault.New("native_choice_binding_required", 409)
	}
	var snapshot map[string]any
	e := s.With(ctx, true, func(dir string) error {
		if e := s.verifyChoiceWithin(dir, scope); e != nil {
			return e
		}
		workers := filepath.Join(dir, "workers")
		worker := filepath.Join(workers, workerID)
		for _, path := range []string{workers, worker} {
			info, e := os.Lstat(path)
			if e != nil && !os.IsNotExist(e) {
				return e
			}
			if e == nil && (!info.IsDir() || info.Mode()&os.ModeSymlink != 0) {
				return fault.New("local_worker_directory_invalid", 409)
			}
		}
		child, e := NewStore(worker, s.Endpoint)
		if e != nil {
			return e
		}
		return child.With(ctx, true, func(actual string) error {
			if filepath.Clean(actual) != filepath.Clean(worker) && !(runtime.GOOS == "windows" && strings.EqualFold(filepath.Clean(actual), filepath.Clean(worker))) {
				return fault.New("local_worker_directory_invalid", 409)
			}
			var e error
			snapshot, e = initializeBareWithin(actual, "agent", "worker")
			return e
		})
	})
	if e != nil {
		return nil, e
	}
	snapshot["workerId"], snapshot["runtimeStarted"], snapshot["localOnly"] = workerID, false, true
	return snapshot, nil
}
