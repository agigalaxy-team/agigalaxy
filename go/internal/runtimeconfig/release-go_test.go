package runtimeconfig

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestActualGoCandidateRuntimeBinding(t *testing.T) {
	directory := os.Getenv("GALAXY_GO_TEST_CORE_CANDIDATE")
	if directory == "" {
		t.Skip("set GALAXY_GO_TEST_CORE_CANDIDATE to inspect an actual built candidate")
	}
	raw, err := os.ReadFile(filepath.Join(directory, "go-core-artifact.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest GoCoreArtifact
	if err = json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(raw)
	configuration := map[string]string{"GALAXY_RELEASE_DIRECTORY": directory, "GALAXY_RELEASE_SHA256": hex.EncodeToString(digest[:]), "GALAXY_CONFIGURATION_VERSION": manifest.ConfigurationVersion}
	entry := filepath.Join(directory, manifest.Entries["galaxy-information-worker"])
	release, err := RuntimeServiceRelease(func(key string) string { return configuration[key] }, "worker", entry)
	if err != nil {
		t.Fatal(err)
	}
	if release.GoCandidate == nil || !release.FilesVerified || release.Kind != "galaxy-go-core-local-candidate" {
		t.Fatal("actual Go candidate lost its own format or file verification")
	}
	if _, ok := runtimeReleaseEntry(release, "api", entry); ok {
		t.Fatal("Information Worker was accepted as API")
	}
	if _, err = AssessSchemaTransition(nil, release, release); err == nil {
		t.Fatal("development candidate must not become a Node production transition")
	}
}
