package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestUpdateRejectsModifiedSignedManifest(t *testing.T) {
	public, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	encode := base64.RawURLEncoding.EncodeToString
	header := encode([]byte(`{"alg":"EdDSA","typ":"galaxy-release+jws","kid":"` + updateKeyID + `"}`))
	payload := encode([]byte(`{"version":1}`))
	message := header + "." + payload
	signature := encode(ed25519.Sign(private, []byte(message)))
	if _, err := decodeUpdateManifest([]byte(message+"."+signature), public); err != nil {
		t.Fatal(err)
	}
	modified := header + "." + encode([]byte(`{"version":2}`)) + "." + signature
	if _, err := decodeUpdateManifest([]byte(modified), public); err == nil {
		t.Fatal("accepted a modified signed manifest")
	}
}

func TestUpdateArchiveRejectsPathsOutsideStaging(t *testing.T) {
	root := t.TempDir()
	destination := filepath.Join(root, "stage")
	if err := os.Mkdir(destination, 0700); err != nil {
		t.Fatal(err)
	}
	var raw bytes.Buffer
	gz := gzip.NewWriter(&raw)
	archive := tar.NewWriter(gz)
	if err := archive.WriteHeader(&tar.Header{Name: "../outside", Mode: 0600, Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	if err := extractUpdate(raw.Bytes(), destination); err == nil {
		t.Fatal("accepted a path outside the staging directory")
	}
	if _, err := os.Stat(filepath.Join(root, "outside")); !os.IsNotExist(err) {
		t.Fatalf("archive escaped staging: %v", err)
	}
}
