package credentials

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicfetch"

	"encoding/json"
	"errors"

	"time"
)

type StatusFetcher func(context.Context, string) (Object, error)
type statusProof struct {
	Payload Object
	Until   int64
	Key     Object
}
type statusFlight struct {
	done  chan struct{}
	proof statusProof
	err   error
}

// FetchPublicStatus follows the original fixed HTTPS public-network contract:
// validate every DNS answer, pin the connection, no proxy/cookies/redirect/retry.
func FetchPublicStatus(ctx context.Context, address string) (Object, error) {
	raw, e := publicfetch.Get(ctx, address, 1048576, 5*time.Second)
	if e != nil {
		return nil, e
	}
	var out Object
	if json.Unmarshal(raw, &out) != nil || out == nil {
		return nil, errors.New("invalid external credential status JSON")
	}
	return out, nil
}
func (s *Service) statusDocument(ctx context.Context, i *Issuer, force bool) (statusProof, error) {
	now := s.now().Unix()
	s.mu.Lock()
	if prior, ok := s.statuses[i.ID]; ok && !force && prior.Until > now {
		s.mu.Unlock()
		return prior, nil
	}
	if !force && s.failures[i.ID] > now {
		s.mu.Unlock()
		return statusProof{}, errors.New("status source temporarily unavailable")
	}
	if pending := s.loading[i.ID]; pending != nil {
		s.mu.Unlock()
		select {
		case <-ctx.Done():
			return statusProof{}, ctx.Err()
		case <-pending.done:
			return pending.proof, pending.err
		}
	}
	flight := &statusFlight{done: make(chan struct{})}
	s.loading[i.ID] = flight
	s.mu.Unlock()
	proof, e := s.loadStatus(ctx, i)
	s.mu.Lock()
	flight.proof, flight.err = proof, e
	if e == nil {
		s.statuses[i.ID] = proof
		delete(s.failures, i.ID)
	} else {
		delete(s.statuses, i.ID)
		s.failures[i.ID] = s.now().Unix() + 10
	}
	delete(s.loading, i.ID)
	close(flight.done)
	s.mu.Unlock()
	return proof, e
}
func (s *Service) loadStatus(ctx context.Context, i *Issuer) (statusProof, error) {
	bad := func() (statusProof, error) {
		return statusProof{}, errors.New("external credential status not confirmed")
	}
	document, e := s.fetch(ctx, i.Revocation.URL)
	if e != nil {
		return statusProof{}, e
	}
	token, ok := document["jwt"].(string)
	if len(document) != 1 || !ok || len(token) > 900000 {
		return bad()
	}
	h, p, e := tokenParts(token, 900000)
	if e != nil {
		return bad()
	}
	iat, e := numericField(p, "iat")
	if e != nil || iat == nil {
		return bad()
	}
	exp, e := numericField(p, "exp")
	now := s.now().Unix()
	if e != nil || exp == nil || *iat > now+30 || *exp <= now || *exp <= *iat || *iat < now-int64(i.Revocation.MaxAgeSeconds) || h["typ"] != "credential-status+jwt" || p["iss"] != i.Issuer || p["purpose"] != "revocation" || p["complete"] != true {
		return bad()
	}
	revoked, ok := p["revoked"].([]any)
	if !ok || len(revoked) > 20000 {
		return bad()
	}
	for _, v := range revoked {
		if !validText(v, 2048) {
			return bad()
		}
	}
	if verifySignature(token, i, h) != nil {
		return bad()
	}
	until := *exp
	if max := *iat + int64(i.Revocation.MaxAgeSeconds); max < until {
		until = max
	}
	var key Object
	for _, k := range i.Keys {
		if k["kid"] == h["kid"] {
			key = k
			break
		}
	}
	return statusProof{p, until, key}, nil
}
func (s *Service) unknown(i *Issuer, reason string) Object {
	var source any
	if i != nil && i.Revocation != nil {
		source = i.Revocation.URL
	}
	return Object{"state": "unknown", "source": source, "checkedAt": iso(s.now()), "validUntil": nil, "reason": reason}
}
func (s *Service) revocation(ctx context.Context, m Object, force bool) Object {
	i := s.issuerURI(str(m["issuer"]))
	if i == nil || i.Revocation == nil || m["credentialId"] == nil {
		return s.unknown(i, "status-source-unavailable")
	}
	vc := object(m["vc"])
	if declared, ok := vc["credentialStatus"]; ok {
		d := object(declared)
		if d == nil || d["type"] != "SignedCredentialStatusList" || d["id"] != i.Revocation.URL {
			return s.unknown(i, "credential-status-format-unsupported")
		}
	}
	proof, e := s.statusDocument(ctx, i, force)
	if e != nil {
		return s.unknown(i, "status-not-confirmed")
	}
	state := "not-revoked"
	for _, v := range proof.Payload["revoked"].([]any) {
		if v == m["credentialId"] {
			state = "revoked"
			break
		}
	}
	issued, _ := numericField(proof.Payload, "iat")
	return Object{"state": state, "source": i.Revocation.URL, "checkedAt": iso(s.now()), "issuedAt": isoSeconds(issued), "validUntil": iso(time.Unix(proof.Until, 0)), "signingKey": proof.Key, "reason": nil}
}
