package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

const (
	updateOrigin = "https://agigalaxy.org"
	updateKeyID  = "galaxy-release-20260911"
	updateKey    = "V1e9dzb64vcyCriizLt9Zcw2-5GZ3Dj4chuPBikHYno"
)

type updateSource struct {
	origin string
	http   *http.Client
}

func officialUpdateSource() updateSource {
	return updateSource{updateOrigin, &http.Client{
		Timeout: 3 * time.Minute,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}}
}

func (s updateSource) read(ctx context.Context, path string, limit int64) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.origin+path, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Cache-Control", "no-cache")
	response, err := s.http.Do(request)
	if err != nil {
		return nil, fmt.Errorf("download %s: %w", path, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download %s: HTTP %d", path, response.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > limit {
		return nil, fault.New("native_update_download_too_large", 502)
	}
	return raw, nil
}

func updateVersion(version string) ([3]uint64, error) {
	var parsed [3]uint64
	parts := strings.Split(version, ".")
	if len(parts) != len(parsed) {
		return parsed, fault.New("native_update_version_invalid", 409)
	}
	for i, part := range parts {
		number, err := strconv.ParseUint(part, 10, 32)
		if err != nil || strconv.FormatUint(number, 10) != part {
			return parsed, fault.New("native_update_version_invalid", 409)
		}
		parsed[i] = number
	}
	return parsed, nil
}

func compareUpdateVersions(left, right string) (int, error) {
	a, err := updateVersion(left)
	if err != nil {
		return 0, err
	}
	b, err := updateVersion(right)
	if err != nil {
		return 0, err
	}
	for i := range a {
		if a[i] < b[i] {
			return -1, nil
		}
		if a[i] > b[i] {
			return 1, nil
		}
	}
	return 0, nil
}

func (s updateSource) latest(ctx context.Context) (string, error) {
	raw, err := s.read(ctx, "/release.json", 2<<20)
	if err != nil {
		return "", err
	}
	var index struct {
		Current struct {
			Version string `json:"version"`
		} `json:"currentNativeClient"`
	}
	if json.Unmarshal(raw, &index) != nil {
		return "", fault.New("native_update_index_invalid", 502)
	}
	_, err = updateVersion(index.Current.Version)
	return index.Current.Version, err
}

type updateKeyPeriod struct {
	ID        string `json:"kid"`
	NotBefore int64  `json:"notBefore"`
	NotAfter  int64  `json:"notAfter"`
	Revoked   *bool  `json:"revoked"`
}

type updateManifest struct {
	Version   int    `json:"version"`
	Kind      string `json:"kind"`
	Publisher string `json:"publisher"`
	Purpose   string `json:"purpose"`
	IssuedAt  int64  `json:"issuedAt"`
	ExpiresAt int64  `json:"expiresAt"`
	Package   struct {
		Name     string `json:"name"`
		Version  string `json:"version"`
		Filename string `json:"filename"`
		SHA256   string `json:"sha256"`
		Bytes    int64  `json:"bytes"`
		Target   struct {
			OS   string `json:"goos"`
			Arch string `json:"goarch"`
		} `json:"target"`
	} `json:"package"`
	Acceptance struct {
		ReportSHA256 string `json:"reportSha256"`
	} `json:"protocolAcceptance"`
}

func decodeUpdateManifest(signed []byte, public ed25519.PublicKey) (updateManifest, error) {
	var manifest updateManifest
	invalid := fault.New("native_update_signature_invalid", 502)
	parts := strings.Split(strings.TrimSpace(string(signed)), ".")
	if len(parts) != 3 {
		return manifest, invalid
	}
	header, err := base64.RawURLEncoding.DecodeString(parts[0])
	var values map[string]string
	if err != nil || json.Unmarshal(header, &values) != nil || len(values) != 3 ||
		values["alg"] != "EdDSA" || values["typ"] != "galaxy-release+jws" || values["kid"] != updateKeyID {
		return manifest, invalid
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !ed25519.Verify(public, []byte(parts[0]+"."+parts[1]), signature) {
		return manifest, invalid
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || json.Unmarshal(payload, &manifest) != nil {
		return manifest, invalid
	}
	return manifest, nil
}

func (s updateSource) key(ctx context.Context, now int64) (ed25519.PublicKey, updateKeyPeriod, error) {
	raw, err := s.read(ctx, "/releases/keys.json", 16<<10)
	if err != nil {
		return nil, updateKeyPeriod{}, err
	}
	var doc struct {
		Publisher string `json:"publisher"`
		Keys      []struct {
			ID   string `json:"kid"`
			Type string `json:"kty"`
			Crv  string `json:"crv"`
			Alg  string `json:"alg"`
			X    string `json:"x"`
		} `json:"keys"`
		Validity []updateKeyPeriod `json:"validity"`
	}
	invalid := fault.New("native_update_signing_key_unavailable", 502)
	if json.Unmarshal(raw, &doc) != nil || doc.Publisher != updateOrigin {
		return nil, updateKeyPeriod{}, invalid
	}
	var period updateKeyPeriod
	for _, p := range doc.Validity {
		if p.ID == updateKeyID {
			if period.ID != "" || p.Revoked == nil || *p.Revoked || now < p.NotBefore || now >= p.NotAfter {
				return nil, updateKeyPeriod{}, invalid
			}
			period = p
		}
	}
	count := 0
	for _, k := range doc.Keys {
		if k.ID == updateKeyID {
			count++
			if k.X != updateKey || k.Type != "OKP" || k.Crv != "Ed25519" || k.Alg != "EdDSA" {
				return nil, updateKeyPeriod{}, invalid
			}
		}
	}
	if count != 1 || period.ID == "" {
		return nil, updateKeyPeriod{}, invalid
	}
	public, err := base64.RawURLEncoding.DecodeString(updateKey)
	return ed25519.PublicKey(public), period, err
}

func (s updateSource) stage(ctx context.Context, version, directory string) error {
	base := "/downloads/native/" + version + "/"
	filename := "galaxy-native-go-" + version + "-" + runtime.GOOS + "-" + runtime.GOARCH + ".tgz"
	now := time.Now().Unix()
	key, period, err := s.key(ctx, now)
	if err != nil {
		return err
	}
	signed, err := s.read(ctx, base+filename+".jws", 64<<10)
	if err != nil {
		return err
	}
	manifest, err := decodeUpdateManifest(signed, key)
	if err != nil {
		return err
	}
	pkg := manifest.Package
	if manifest.Version != 1 || manifest.Kind != "galaxy-native-go-release" || manifest.Publisher != updateOrigin ||
		manifest.Purpose != "release" || manifest.IssuedAt < period.NotBefore || manifest.IssuedAt > now ||
		manifest.ExpiresAt <= now || manifest.ExpiresAt > period.NotAfter || manifest.ExpiresAt-manifest.IssuedAt > 30*86400 ||
		pkg.Name != "@galaxy/native-go-candidate" || pkg.Version != version || pkg.Filename != filename ||
		pkg.Target.OS != runtime.GOOS || pkg.Target.Arch != runtime.GOARCH || pkg.Bytes <= 0 || pkg.Bytes > 64<<20 {
		return fault.New("native_update_signed_release_invalid", 502)
	}
	report, err := s.read(ctx, base+filename+".report.json", 256<<10)
	if err != nil {
		return err
	}
	archive, err := s.read(ctx, base+filename, pkg.Bytes)
	if err != nil {
		return err
	}
	digest, reportDigest := sha256.Sum256(archive), sha256.Sum256(report)
	if int64(len(archive)) != pkg.Bytes || hex.EncodeToString(digest[:]) != pkg.SHA256 ||
		hex.EncodeToString(reportDigest[:]) != manifest.Acceptance.ReportSHA256 {
		return fault.New("native_update_package_digest_invalid", 502)
	}
	return extractUpdate(archive, directory)
}

func extractUpdate(archive []byte, directory string) error {
	compressed, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return err
	}
	defer compressed.Close()
	reader := tar.NewReader(compressed)
	var total int64
	for count := 0; ; count++ {
		entry, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		name := strings.TrimPrefix(entry.Name, "./")
		if count >= 10000 || entry.Typeflag != tar.TypeReg || !fs.ValidPath(name) || name == "." ||
			!filepath.IsLocal(filepath.FromSlash(name)) || strings.ContainsAny(name, "\\:") || entry.Size > (512<<20)-total {
			return fault.New("native_update_archive_entry_invalid", 502)
		}
		total += entry.Size
		target := filepath.Join(directory, filepath.FromSlash(name))
		if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return err
		}
		mode := os.FileMode(0600)
		if entry.Mode&0111 != 0 {
			mode = 0700
		}
		file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(file, reader)
		if err = errors.Join(copyErr, file.Close()); err != nil {
			return err
		}
	}
}
