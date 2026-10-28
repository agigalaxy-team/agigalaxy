package accounts

import (
	"encoding/json"
	"math"
	"net/http"
	"regexp"
	"strconv"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

var publicSubjectPath = regexp.MustCompile(`^/v1/account/public/by-id/(GUID[0-9A-Z]{28})$`)
var publicListPath = regexp.MustCompile(`^/v1/account/public/([0-9a-f-]{36})/(ids|credentials|posts)$`)
var decimalQueryNumber = regexp.MustCompile(`^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)
var basedQueryNumber = regexp.MustCompile(`^0(?:[xX][0-9a-fA-F]+|[bB][01]+|[oO][0-7]+)$`)

func publicLimit(value string) (int, error) {
	value = trim(value)
	var n float64
	var e error
	if basedQueryNumber.MatchString(value) {
		var integer uint64
		integer, e = strconv.ParseUint(value, 0, 64)
		n = float64(integer)
	} else if decimalQueryNumber.MatchString(value) {
		n, e = strconv.ParseFloat(value, 64)
	} else {
		return 0, queryInvalid()
	}
	if e != nil || math.IsNaN(n) || math.IsInf(n, 0) || n != math.Trunc(n) || n < 1 || n > 50 {
		return 0, queryInvalid()
	}
	return int(n), nil
}
func publicPageInput(r *http.Request) ([]byte, error) {
	page := Object{}
	for key, values := range r.URL.Query() {
		if key != "after" && key != "limit" || len(values) != 1 {
			return nil, queryInvalid()
		}
		if key == "after" {
			page[key] = values[0]
		} else {
			limit, e := publicLimit(values[0])
			if e != nil {
				return nil, e
			}
			page[key] = limit
		}
	}
	return json.Marshal(page)
}
func (h Handler) dispatchPublicPage(r *http.Request, subject, list []string) (Object, error) {
	if r.Method != "GET" {
		return nil, fault.New("not_found", 404)
	}
	if h.Service == nil || h.Pool == nil || h.Identity == nil {
		return nil, unavailable()
	}
	raw, e := publicPageInput(r)
	if e != nil {
		return nil, e
	}
	q := &PublicQueries{Service: h.Service, Providers: h.Providers, CurrentProviders: h.CurrentProviders, Credentials: h.PublicCredentialsPage, Posts: h.PublicPostsPage}
	return postgres.InTx(r.Context(), h.Pool, func(tx pgx.Tx) (Object, error) {
		if subject != nil {
			return q.AccountsForIDWithin(r.Context(), tx, subject[1], raw)
		}
		switch list[2] {
		case "ids":
			return q.LinkedIDsWithin(r.Context(), tx, list[1], raw)
		case "credentials":
			return q.CredentialsWithin(r.Context(), tx, list[1], raw)
		default:
			return q.PostsWithin(r.Context(), tx, list[1], raw)
		}
	})
}
