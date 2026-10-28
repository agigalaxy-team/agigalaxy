// Package docsmcp exposes only the existing reviewed public document bundle.
// Resource names never become filesystem paths or remote fetch requests.
package docsmcp

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"regexp"
	"strings"
	"unicode/utf8"
)

var topics = []string{"overview", "installation", "compatibility", "privacy"}
var knownVersion = regexp.MustCompile(`^(?:v0\.[1-4]|(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$`)

type Catalog struct {
	current   string
	versions  []string
	documents map[string]map[string]string
}

func invalidCatalog() error { return errors.New("invalid public document catalog") }

// Load reads the unchanged build_public_docs.py output, without following any
// document path, include directive, or URL contained in a document.
func Load(path string) (*Catalog, error) {
	raw, e := os.ReadFile(path)
	if e != nil {
		return nil, e
	}
	return Parse(raw)
}
func Parse(raw []byte) (*Catalog, error) {
	if !utf8.Valid(raw) {
		return nil, invalidCatalog()
	}
	var b struct {
		SchemaVersion  int                          `json:"schemaVersion"`
		Version        string                       `json:"version"`
		Documents      map[string]string            `json:"documents"`
		Versions       map[string]json.RawMessage   `json:"versions"`
		DocumentHashes map[string]map[string]string `json:"documentHashes"`
	}
	if json.Unmarshal(raw, &b) != nil || len(b.Versions) < 1 || len(b.Versions) > 32 {
		return nil, invalidCatalog()
	}
	if _, ok := b.Versions[b.Version]; !ok {
		return nil, invalidCatalog()
	}
	// Preserve the source catalog order for the advertised version enum.
	var top map[string]json.RawMessage
	_ = json.Unmarshal(raw, &top)
	decoder := json.NewDecoder(bytes.NewReader(top["versions"]))
	_, _ = decoder.Token()
	c := &Catalog{current: b.Version, documents: map[string]map[string]string{}}
	for decoder.More() {
		token, e := decoder.Token()
		if e != nil {
			return nil, invalidCatalog()
		}
		v, ok := token.(string)
		if !ok || !knownVersion.MatchString(v) {
			return nil, invalidCatalog()
		}
		var ignored json.RawMessage
		if decoder.Decode(&ignored) != nil {
			return nil, invalidCatalog()
		}
		c.versions = append(c.versions, v)
	}
	for v, raw := range b.Versions {
		var docs map[string]string
		if !knownVersion.MatchString(v) || json.Unmarshal(raw, &docs) != nil || len(docs) != len(topics) {
			return nil, invalidCatalog()
		}
		for _, topic := range topics {
			text, ok := docs[topic]
			if !ok || len(text) == 0 || len(text) > 16384 || strings.ContainsRune(text, 0) {
				return nil, invalidCatalog()
			}
			if b.SchemaVersion == 2 {
				sum := sha256.Sum256([]byte(text))
				if b.DocumentHashes[v][topic] != hex.EncodeToString(sum[:]) {
					return nil, invalidCatalog()
				}
			}
		}
		c.documents[v] = docs
	}
	for _, topic := range topics {
		if b.Documents[topic] != c.documents[c.current][topic] {
			return nil, invalidCatalog()
		}
	}
	return c, nil
}
func (c *Catalog) document(version, topic string) (string, error) {
	if c == nil {
		return "", invalidCatalog()
	}
	if version == "current" {
		version = c.current
	}
	if docs, ok := c.documents[version]; ok {
		if text, ok := docs[topic]; ok {
			return text, nil
		}
	}
	return "", errors.New("unknown public document or version")
}
