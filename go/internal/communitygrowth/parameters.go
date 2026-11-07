package communitygrowth

import (
	"context"
	"fmt"
	"math/big"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const experienceAdoption = "governance-experience-adopt"

type experienceRule struct {
	label, sourceKind   string
	experience, version int64
	enabled             bool
}

func (s *Service) experienceRuleWithin(ctx context.Context, tx pgx.Tx, scope string) (experienceRule, error) {
	var r experienceRule
	err := tx.QueryRow(ctx, `SELECT label,source_kind,experience,enabled,version FROM community_growth_rules_v1
		WHERE endpoint=$1 AND rule_key=$2`, s.Endpoint, scope).Scan(&r.label, &r.sourceKind, &r.experience, &r.enabled, &r.version)
	if noRows(err) {
		return r, fault.New("community_growth_rule_not_found", 404)
	}
	return r, err
}

// PreviewCommunityParametersWithin returns a single existing global rule. The
// governance proposal may change its experience, while labels and eligibility
// remain with the regular rule editor.
func (s *Service) PreviewCommunityParametersWithin(ctx context.Context, tx pgx.Tx, actor Actor, scope string, patch Object) (Object, error) {
	if _, err := s.require(ctx, tx, actor, "rules.read"); err != nil {
		return nil, err
	}
	experience, valid := integer(patch["experience"])
	if len(patch) != 0 && (len(patch) != 1 || !valid || experience < 0) {
		return nil, invalid()
	}
	if err := s.ensureDefaults(ctx, tx); err != nil {
		return nil, err
	}
	r, err := s.experienceRuleWithin(ctx, tx, scope)
	if err != nil {
		return nil, err
	}
	if len(patch) == 0 {
		experience = r.experience
	}
	sample, summary, err := s.experienceSampleWithin(ctx, tx, scope, r, experience)
	if err != nil {
		return nil, err
	}
	return Object{"version": r.version, "label": r.label, "before": Object{"experience": r.experience}, "after": Object{"experience": experience}, "sample": sample, "sampleSummary": summary}, nil
}

func (s *Service) experienceSampleWithin(ctx context.Context, tx pgx.Tx, scope string, rule experienceRule, experience int64) (Object, string, error) {
	if s.Forum == nil {
		return nil, "暂无可比较的社区样本。", nil
	}
	const days, limit = 30, 100
	now := s.now()
	rows, err := tx.Query(ctx, `SELECT source_id,account_id::text,object_kind,object_id
		FROM community_growth_sources_v1
		WHERE endpoint=$1 AND rule_key=$2 AND source_kind=$3 AND active AND occurred_at>=$4 AND occurred_at<=$5
		ORDER BY occurred_at DESC,id DESC LIMIT $6`, s.Endpoint, scope, rule.sourceKind, now.AddDate(0, 0, -days), now, limit)
	if err != nil {
		return nil, "", err
	}
	type sampleRow struct {
		account string
		growthRow
	}
	rowsByAccount, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (sampleRow, error) {
		r := sampleRow{growthRow: growthRow{Kind: rule.sourceKind}}
		err := row.Scan(&r.ID, &r.account, &r.ObjectKind, &r.ObjectID)
		return r, err
	})
	if err != nil {
		return nil, "", err
	}
	var count int64
	if len(rowsByAccount) != 0 {
		refs := make([]publicObjectRef, 0, len(rowsByAccount))
		batch := make([]growthRow, 0, len(rowsByAccount))
		for _, r := range rowsByAccount {
			refs = append(refs, publicObjectRef{r.ObjectKind, r.ObjectID})
			batch = append(batch, r.growthRow)
		}
		cache := eligibilityCache{}
		if err = s.prefetchWithin(ctx, tx, cache, refs); err != nil {
			return nil, "", err
		}
		facts, err := s.batchSourceFacts(ctx, tx, batch)
		if err != nil {
			return nil, "", err
		}
		for _, r := range rowsByAccount {
			if facts.current(r.account, r.growthRow, cache[r.ObjectKind+":"+r.ObjectID]) {
				count++
			}
		}
	}
	sample := Object{"windowDays": days, "sampledCount": len(rowsByAccount), "eligibleCount": count}
	if count == 0 {
		return sample, "近 30 天的样本中暂无同类公开有效事项。", nil
	}
	summary := fmt.Sprintf("抽取近 30 天的 %d 条同类记录，其中 %d 条当前公开有效。", len(rowsByAccount), count)
	if !rule.enabled {
		return sample, summary + "该规则当前停用。", nil
	}
	before := new(big.Int).Mul(big.NewInt(rule.experience), big.NewInt(count)).String()
	after := new(big.Int).Mul(big.NewInt(experience), big.NewInt(count)).String()
	sample["beforeExperience"], sample["afterExperience"] = before, after
	return sample, summary + fmt.Sprintf("若再取得同样数量的新事项，经验合计从 %s 调为 %s。", before, after), nil
}

func experienceAdoptionInput(scope string, input Object) (Object, error) {
	op, reason := str(input, "operationId"), str(input, "reason")
	version, versionOK := integer(input["expectedVersion"])
	experience, experienceOK := integer(input["experience"])
	if _, err := uuid.Parse(op); err != nil || scope == "" || reason == "" || utf8.RuneCountInString(reason) > 4000 ||
		len(input) != 4 || !versionOK || version < 1 || !experienceOK || experience < 0 {
		return nil, invalid()
	}
	return Object{"operationId": op, "ruleKey": scope, "reason": reason, "expectedVersion": version, "experience": experience}, nil
}

// AdoptCommunityParametersWithin is called with the current human confirmer,
// inside the original business card transaction.
func (s *Service) AdoptCommunityParametersWithin(ctx context.Context, tx pgx.Tx, actor Actor, scope string, input Object) (Object, error) {
	fresh, err := s.require(ctx, tx, actor, "rules.write")
	if err != nil {
		return nil, err
	}
	if fresh.AIProof != nil || (s.Authority.Duty != nil && s.Authority.Duty.AcceptsDuty(fresh)) ||
		(s.Authority.Execution != nil && s.Authority.Execution.AcceptsExecution(fresh)) {
		return nil, fault.New("business_admin_denied", 403)
	}
	selection, err := experienceAdoptionInput(scope, input)
	if err != nil {
		return nil, err
	}
	return s.commandWithin(ctx, tx, fresh, experienceAdoption, str(selection, "operationId"), selection, func() (Object, error) {
		r, err := s.experienceRuleWithin(ctx, tx, scope)
		if err != nil {
			return nil, err
		}
		expected := selection["expectedVersion"].(int64)
		experience := selection["experience"].(int64)
		result, err := s.saveRule(ctx, tx, Object{"ruleKey": scope, "label": r.label, "enabled": r.enabled, "experience": experience, "expectedVersion": expected})
		if err != nil {
			return nil, err
		}
		result["experience"] = experience
		return result, nil
	})
}

func (s *Service) CommunityParametersReceiptWithin(ctx context.Context, tx pgx.Tx, actor Actor, scope string, input Object) (Object, error) {
	fresh, err := s.require(ctx, tx, actor, "rules.read")
	if err != nil {
		return nil, err
	}
	selection, err := experienceAdoptionInput(scope, input)
	if err != nil {
		return nil, err
	}
	data, err := identity.Canonical(selection)
	if err != nil {
		return nil, err
	}
	op := str(selection, "operationId")
	result, err := s.operationWithin(ctx, tx, fresh, experienceAdoption, op, identity.Digest(data))
	if err != nil {
		return nil, err
	}
	if result == nil {
		return Object{"state": "not-recorded", "operationId": op}, nil
	}
	return Object{"state": "recorded", "operationId": op, "result": result}, nil
}
