package main

import (
	"net/http"
	"os"
	"path/filepath"

	"github.com/agigalaxy-team/agigalaxy/go/internal/docsmcp"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

func documentationHandler(endpoint string, next http.Handler) (http.Handler, error) {
	bundle := os.Getenv("GALAXY_PUBLIC_DOCS_FILE")
	if bundle == "" {
		executable, err := os.Executable()
		if err != nil {
			return nil, err
		}
		bundle = filepath.Join(filepath.Dir(executable), "public-docs.json")
	}
	if !filepath.IsAbs(bundle) {
		return nil, fault.New("public_docs_path_invalid", 400)
	}
	catalog, err := docsmcp.Load(bundle)
	if err != nil {
		return nil, err
	}
	return docsmcp.NewHandler(endpoint, catalog, next)
}
