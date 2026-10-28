package civ2

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
	"strings"
)

type ProofQuery struct {
	SubjectID, CaseID string
	ResultRef         Object
	EvidenceRefs      []Object
	Policy            Object
}

func (s *Service) ProofsForWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, in ProofQuery) ([]Object, error) {
	allowed := map[string]bool{}
	for _, ref := range in.EvidenceRefs {
		allowed[fmt.Sprintf("%s:%d", str(ref, "id"), num(ref, "version"))] = true
	}
	items := []Object{}
	var after any
	for {
		rows, e := tx.Query(ctx, `SELECT p.id::text,r.evidence_id::text,r.evidence_version FROM ci_proofs_v2 p JOIN ci_requests_v2 r ON r.id=p.request_id WHERE p.subject_id=$1 AND r.subject_id=$1 AND r.case_id=$2 AND r.result_id=$3 AND r.result_version=$4 AND ($5::uuid IS NULL OR p.id>$5) ORDER BY p.id LIMIT 100`, in.SubjectID, in.CaseID, in.ResultRef["id"], in.ResultRef["version"], after)
		if e != nil {
			return nil, e
		}
		type candidate struct {
			id, evidence string
			version      int64
		}
		page := []candidate{}
		for rows.Next() {
			var r candidate
			if e = rows.Scan(&r.id, &r.evidence, &r.version); e != nil {
				rows.Close()
				return nil, e
			}
			page = append(page, r)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, e
		}
		for _, row := range page {
			if !allowed[fmt.Sprintf("%s:%d", row.evidence, row.version)] {
				continue
			}
			view, e := s.ProofWithin(ctx, tx, a, row.id)
			if e != nil {
				if fault.Code(e) == "internal_error" {
					return nil, e
				}
				continue
			}
			data := obj(view["data"])
			if in.Policy != nil {
				found := false
				repos, _ := in.Policy["repositories"].([]any)
				for _, r := range repos {
					r := obj(r)
					source := obj(data["source"])
					if strings.EqualFold(str(r, "owner"), str(source, "owner")) && strings.EqualFold(str(r, "repository"), str(source, "repository")) {
						found = true
						break
					}
				}
				if !found {
					continue
				}
			}
			items = append(items, Object{"proofId": row.id, "sourceKey": obj(view["provenance"])["sourceKey"], "commit": obj(data["source"])["commit"], "conclusion": data["conclusion"], "statusUrl": s.Endpoint + str(data, "statusPath"), "synthetic": data["synthetic"], "independentExecutionVerified": false})
		}
		if len(page) < 100 {
			break
		}
		after = page[len(page)-1].id
	}
	return items, nil
}
