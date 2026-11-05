package accountlinks

import (
	"context"
	"crypto/subtle"
	"regexp"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

var nativeSubject = regexp.MustCompile("^GUID1[0-5][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$")
var nativeSecret = regexp.MustCompile("^[a-f0-9]{64}$")

// Native login precedes device registration. The temporary login secret can read
// only this login; claiming still requires the original ID's active device.
func (l *Links) NativeBegin(ctx context.Context, raw []byte) (Object, error) {
	var in struct {
		SubjectID string `json:"subjectId"`
		Proof     string `json:"proof"`
	}
	if decode(raw, &in) != nil || !nativeSubject.MatchString(in.SubjectID) || !nativeSecret.MatchString(in.Proof) {
		return nil, fault.New("invalid_request", 400)
	}
	for _, id := range l.providerOrder {
		provider := l.providers[id]
		if l.NativeIssuer != "" && provider.Describe().Issuer == l.NativeIssuer {
			return l.start(ctx, provider, in.SubjectID, "", in.Proof)
		}
	}
	return nil, fault.New("identity_provider_unavailable", 503)
}

type nativeLoginInput struct {
	ID     string `json:"id"`
	Secret string `json:"secret"`
}

func parseNativeLogin(raw []byte) (nativeLoginInput, error) {
	var in nativeLoginInput
	if decode(raw, &in) != nil || !validUUID(in.ID) || !nativeSecret.MatchString(in.Secret) {
		return in, fault.New("invalid_request", 400)
	}
	return in, nil
}

func (l *Links) nativeLogin(in nativeLoginInput) (*pendingLink, error) {
	p := l.pending[in.ID]
	if p == nil || p.expires <= l.Registry.now().Unix() || subtle.ConstantTimeCompare([]byte(p.nativeProof), []byte(identity.Digest([]byte(in.Secret)))) != 1 {
		return nil, loginUnavailable()
	}
	return p, nil
}

func (l *Links) NativeStatus(ctx context.Context, raw []byte) (Object, error) {
	in, err := parseNativeLogin(raw)
	if err != nil {
		return nil, err
	}
	l.purge(ctx)
	l.mu.Lock()
	defer l.mu.Unlock()
	p, err := l.nativeLogin(in)
	if err != nil {
		return nil, err
	}
	out := Object{"state": p.state, "id": in.ID, "subjectId": p.subject}

	return out, nil
}

func (l *Links) NativeClaim(ctx context.Context, actor deviceauth.Actor, raw []byte) (Object, error) {
	in, err := parseNativeLogin(raw)
	if err != nil {
		return nil, err
	}
	return postgres.InTx(ctx, l.Registry.Pool, func(tx pgx.Tx) (Object, error) {
		if _, err := l.Registry.Devices.CurrentControlWithin(ctx, tx, actor, "binding"); err != nil {
			return nil, err
		}
		l.mu.Lock()
		p, err := l.nativeLogin(in)
		if err != nil || p.subject != actor.SubjectID || p.verified.ExpiresAt <= l.Registry.now().Unix() || (p.state != "native-approved" && (p.state != "awaiting-local-signature" || p.binding != actor.BindingID)) {
			l.mu.Unlock()
			return nil, loginUnavailable()
		}
		issuer, external := p.verified.Issuer, p.verified.ExternalSubject
		if p.state == "native-approved" {
			p.binding = actor.BindingID
			l.setIntent(in.ID, p, p.verified)
		}
		l.mu.Unlock()
		var linked bool
		err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM external_identity_links l JOIN community_account_links a ON a.identity_link_id=l.id WHERE l.endpoint=$1 AND l.subject_id=$2 AND l.issuer=$3 AND l.external_subject=$4 AND l.revoked_at IS NULL)`, l.Registry.Endpoint, actor.SubjectID, issuer, external).Scan(&linked)
		if err != nil {
			return nil, err
		}
		return Object{"id": in.ID, "alreadyLinked": linked}, nil
	})
}
