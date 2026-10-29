package runtimeconfig

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
)

type ReleaseMigration struct {
	Version int64  `json:"version"`
	SHA256  string `json:"sha256"`
}
type ReleaseFile struct {
	Bytes  *int64 `json:"bytes"`
	SHA256 string `json:"sha256"`
}

// ServiceRelease retains the original immutable service-release manifest. A
// runtime observation contains only its three original public reference fields.
type ServiceRelease struct {
	Version                   int                    `json:"version"`
	Kind                      string                 `json:"kind"`
	ReleaseID                 string                 `json:"releaseId"`
	ConfigurationVersion      string                 `json:"configurationVersion"`
	CreatedAt                 string                 `json:"createdAt"`
	MinimumNode               string                 `json:"minimumNode"`
	Component                 string                 `json:"component"`
	Entries                   map[string]string      `json:"entries"`
	Migrations                []ReleaseMigration     `json:"migrations"`
	Files                     map[string]ReleaseFile `json:"files"`
	Directory, ManifestSHA256 string
	FilesVerified             bool
	GoCandidate               *GoCoreArtifact `json:"-"`
}

func (r *ServiceRelease) Observation() Object {
	if r == nil {
		return nil
	}
	return Object{"releaseId": r.ReleaseID, "configurationVersion": r.ConfigurationVersion, "manifestSha256": r.ManifestSHA256}
}

var releaseName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._/-]*$`)

func safeReleaseName(name string) bool {
	if !releaseName.MatchString(name) {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}
func releaseMismatch(message string) error { return fmt.Errorf("%s", message) }
func InspectServiceRelease(directory, expectedManifestSHA256 string) (*ServiceRelease, error) {
	if !filepath.IsAbs(directory) || !sha.MatchString(expectedManifestSHA256) {
		return nil, releaseMismatch("Pinned release directory and digest required")
	}
	raw, e := os.ReadFile(filepath.Join(directory, "service-release.json"))
	if e != nil {
		return nil, e
	}
	sum := sha256.Sum256(raw)
	if hex.EncodeToString(sum[:]) != expectedManifestSHA256 {
		return nil, releaseMismatch("Service release manifest mismatch")
	}
	var manifest ServiceRelease
	if e = json.Unmarshal(raw, &manifest); e != nil {
		return nil, e
	}
	versions := databaseschema.Versions()
	if manifest.Version != 1 || manifest.Kind != "galaxy-official-service-release" || !ref.MatchString(manifest.ReleaseID) || !ref.MatchString(manifest.ConfigurationVersion) || len(manifest.Migrations) == 0 || len(manifest.Migrations) > len(versions) {
		return nil, releaseMismatch("Invalid service release manifest")
	}
	for i, m := range manifest.Migrations {
		if m.Version != int64(versions[i]) || !sha.MatchString(m.SHA256) {
			return nil, releaseMismatch("Invalid service release manifest")
		}
	}
	if manifest.Entries == nil || len(manifest.Files) < 4 || len(manifest.Files) > 2000 {
		return nil, releaseMismatch("Invalid service release files")
	}
	for _, name := range manifest.Entries {
		if _, exists := manifest.Files[name]; !exists {
			return nil, releaseMismatch("Invalid service release files")
		}
	}
	if e = verifyReleaseFiles(directory, manifest.Files); e != nil {
		return nil, e
	}
	manifest.Directory, manifest.ManifestSHA256, manifest.FilesVerified = directory, expectedManifestSHA256, true
	return &manifest, nil
}

// RuntimeServiceRelease reads the same three explicit release references. The
// executable must be the pinned role's actual manifest file; inspecting a Node
// source release never makes a Go process a verified member of that release.
func RuntimeServiceRelease(getenv func(string) string, role, entryFile string) (*ServiceRelease, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	directory, pin := getenv("GALAXY_RELEASE_DIRECTORY"), getenv("GALAXY_RELEASE_SHA256")
	if directory == "" && pin == "" {
		return nil, nil
	}
	release, e := inspectRuntimeRelease(directory, pin)
	if e != nil {
		return nil, e
	}
	if entryFile == "" {
		entryFile, e = os.Executable()
		if e != nil {
			return nil, e
		}
	}
	entry, exists := runtimeReleaseEntry(release, role, entryFile)
	actual, e := filepath.Abs(entryFile)
	if e != nil {
		return nil, e
	}
	selected, e := filepath.Abs(filepath.Join(release.Directory, filepath.FromSlash(entry)))
	if e != nil {
		return nil, e
	}
	if !exists || actual != selected || getenv("GALAXY_CONFIGURATION_VERSION") != release.ConfigurationVersion {
		return nil, releaseMismatch("Runtime does not match selected service release")
	}
	return release, nil
}
func AssessSchemaTransition(actualVersions []int64, from, to *ServiceRelease) (Object, error) {
	if from == nil || to == nil || from.Kind != "galaxy-official-service-release" || to.Kind != "galaxy-official-service-release" {
		return nil, releaseMismatch("Selected service releases required")
	}
	for i, m := range from.Migrations {
		if i < len(to.Migrations) && m.SHA256 != to.Migrations[i].SHA256 {
			return nil, releaseMismatch("Historical migration SQL changed between releases")
		}
	}
	expected := make([]int64, len(to.Migrations))
	for i, m := range to.Migrations {
		expected[i] = m.Version
	}
	if !slices.Equal(actualVersions, expected) {
		return nil, releaseMismatch("Target release is incompatible with current database; application rollback refused")
	}
	return Object{"fromRelease": from.ReleaseID, "toRelease": to.ReleaseID, "schema": expected[len(expected)-1], "applicationOnly": true, "databaseDowngrade": false, "compatible": true}, nil
}
func InspectServiceTransition(ctx context.Context, pool *pgxpool.Pool, fromDirectory, fromDigest, toDirectory, toDigest string) (Object, error) {
	from, e := InspectServiceRelease(fromDirectory, fromDigest)
	if e != nil {
		return nil, e
	}
	to, e := InspectServiceRelease(toDirectory, toDigest)
	if e != nil {
		return nil, e
	}
	tx, e := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if e != nil {
		return nil, e
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	rows, e := tx.Query(ctx, "SELECT version FROM schema_migrations ORDER BY version")
	if e != nil {
		return nil, e
	}
	versions := []int64{}
	for rows.Next() {
		var version int64
		if e = rows.Scan(&version); e != nil {
			rows.Close()
			return nil, e
		}
		versions = append(versions, version)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	out, e := AssessSchemaTransition(versions, from, to)
	if e != nil {
		return nil, e
	}
	if e = postgres.AssertRecoveryReady(ctx, tx); e != nil {
		return nil, e
	}
	out["fromManifestSha256"], out["toManifestSha256"] = fromDigest, toDigest
	out["fromConfigurationVersion"], out["toConfigurationVersion"] = from.ConfigurationVersion, to.ConfigurationVersion
	out["proxyReloaded"], out["runtimeVerified"] = false, false
	out["inspectedAt"] = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	if e = tx.Commit(ctx); e != nil {
		return nil, e
	}
	return out, nil
}

func verifyReleaseFiles(directory string, files map[string]ReleaseFile) error {
	return verifyReleaseFilesNamed(directory, files, safeReleaseName)
}
func verifyReleaseFilesNamed(directory string, files map[string]ReleaseFile, validName func(string) bool) error {
	for name, expected := range files {
		if !validName(name) {
			return releaseMismatch("Invalid release path")
		}
		path := filepath.Join(directory, filepath.FromSlash(name))
		absolute, e := filepath.Abs(path)
		if e != nil {
			return e
		}
		actual, e := filepath.EvalSymlinks(path)
		if e != nil {
			return e
		}
		info, e := os.Lstat(path)
		if e != nil {
			return e
		}
		if actual != absolute || !info.Mode().IsRegular() {
			return releaseMismatch("Release file must be regular")
		}
		file, e := os.Open(path)
		if e != nil {
			return e
		}
		hash := sha256.New()
		bytes, e := io.Copy(hash, file)
		closed := file.Close()
		if e != nil {
			return e
		}
		if closed != nil {
			return closed
		}
		if expected.Bytes == nil || bytes != *expected.Bytes || hex.EncodeToString(hash.Sum(nil)) != expected.SHA256 {
			return releaseMismatch("Service release file mismatch")
		}
	}
	return nil
}
