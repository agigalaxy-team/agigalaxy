package runtimeconfig

import (
	"context"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

type honorDefinition struct {
	Definition Object
	Hash       string
}

func prepareRegistries(raw Object) (Object, []honorDefinition, error) {
	input := object(clone(raw))
	snapshot := object(input["snapshot"])
	if snapshot == nil {
		return nil, nil, invalid()
	}
	component := input["component"]
	rules := []honorDefinition(nil)
	for _, entry := range []struct{ Field, Registry, Hash string }{{"experienceReviewers", "experienceReviewerRegistry", ""}, {"honorRules", "honorRegistry", "honorRules"}, {"qualificationPolicies", "qualificationRegistry", "qualificationPolicies"}} {
		values, present := input[entry.Field]
		delete(input, entry.Field)
		if !present {
			if snapshot[entry.Registry] != nil {
				return nil, nil, mismatch(map[string]string{"honorRules": "Honor registry observation requires loaded definitions", "qualificationPolicies": "Qualification registry observation requires loaded definitions", "experienceReviewers": "Experience registry observation requires loaded definitions"}[entry.Field])
			}
			continue
		}
		config, e := parseGovernance(Object{entry.Field: values})
		if e != nil {
			return nil, nil, e
		}
		values = config[entry.Field]
		if component != "api" {
			if entry.Field == "experienceReviewers" {
				return nil, nil, mismatch("Experience reviewers require API runtime")
			}
			return nil, nil, mismatch(map[string]string{"honorRules": "Honor rules do not match loaded governance", "qualificationPolicies": "Qualification policies do not match loaded governance"}[entry.Field])
		}
		if entry.Hash != "" && hash(values) != str(object(object(snapshot["governance"])["policyHashes"])[entry.Hash]) {
			return nil, nil, mismatch(map[string]string{"honorRules": "Honor rules do not match loaded governance", "qualificationPolicies": "Qualification policies do not match loaded governance"}[entry.Field])
		}
		rows := []any{}
		seen := map[string]bool{}
		for _, v := range array(values) {
			p := object(v)
			switch entry.Field {
			case "experienceReviewers":
				id := str(p["subjectId"])
				if seen[id] {
					return nil, nil, mismatch("Duplicate experience reviewer")
				}
				seen[id] = true
				definition := object(clone(p))
				definition["capabilityIds"] = orderedStrings(p["capabilityIds"], true, false)
				definition["kinds"] = orderedStrings(p["kinds"], true, false)
				rows = append(rows, Object{"subjectId": id, "definitionHash": hash(definition)})
			case "honorRules":
				key := str(p["id"]) + "@" + str(p["version"])
				if seen[key] {
					return nil, nil, mismatch("Duplicate Honor rule version")
				}
				seen[key] = true
				definition := object(clone(p))
				definition["revoked"] = false
				definition["members"] = orderedStrings(p["members"], false, false)
				groups := []any{}
				for _, group := range array(p["relatedPartyGroups"]) {
					groups = append(groups, orderedStrings(group, false, false))
				}
				sort.SliceStable(groups, func(i, j int) bool { return jsonText(groups[i]) < jsonText(groups[j]) })
				definition["relatedPartyGroups"] = groups
				repos := []any{}
				for _, v := range array(p["repositories"]) {
					r := object(v)
					repos = append(repos, Object{"owner": strings.ToLower(str(r["owner"])), "repository": strings.ToLower(str(r["repository"]))})
				}
				sort.SliceStable(repos, func(i, j int) bool { return jsonText(repos[i]) < jsonText(repos[j]) })
				definition["repositories"] = repos
				h := hash(definition)
				rules = append(rules, honorDefinition{definition, h})
				rows = append(rows, Object{"ruleId": p["id"], "ruleVersion": p["version"], "definitionHash": h, "revoked": p["revoked"]})
			case "qualificationPolicies":
				key := str(p["id"]) + "@" + str(p["version"])
				if seen[key] {
					return nil, nil, mismatch("Duplicate qualification policy version")
				}
				seen[key] = true
				definition := object(clone(p))
				repos := map[string]Object{}
				for _, v := range array(p["repositories"]) {
					r := object(v)
					n := Object{"owner": strings.ToLower(str(r["owner"])), "repository": strings.ToLower(str(r["repository"]))}
					b, _ := canonical(n)
					repos[string(b)] = n
				}
				keys := []string{}
				for k := range repos {
					keys = append(keys, k)
				}
				localeSort(keys)
				out := []any{}
				for _, k := range keys {
					out = append(out, repos[k])
				}
				definition["repositories"] = out
				rows = append(rows, Object{"policyId": p["id"], "policyVersion": p["version"], "definitionHash": hash(definition)})
			}
		}
		c := collate.New(language.English)
		sort.SliceStable(rows, func(i, j int) bool {
			a, b := object(rows[i]), object(rows[j])
			switch entry.Field {
			case "honorRules":
				return str(a["ruleId"])+"@"+str(a["ruleVersion"]) < str(b["ruleId"])+"@"+str(b["ruleVersion"])
			case "qualificationPolicies":
				return c.CompareString(str(a["policyId"])+"@"+str(a["policyVersion"]), str(b["policyId"])+"@"+str(b["policyVersion"])) < 0
			default:
				return c.CompareString(str(a["subjectId"]), str(b["subjectId"])) < 0
			}
		})
		field := "rules"
		if entry.Field == "qualificationPolicies" {
			field = "policies"
		}
		if entry.Field == "experienceReviewers" {
			field = "reviewers"
		}
		snapshot[entry.Registry] = Object{"version": 1, field: rows}
	}
	return input, rules, nil
}
func localeSort(keys []string) {
	c := collate.New(language.English)
	sort.SliceStable(keys, func(i, j int) bool { return c.CompareString(keys[i], keys[j]) < 0 })
}
func assertQualificationVersions(ctx context.Context, tx pgx.Tx, endpoint string, registry Object) error {
	ids := []string{}
	for _, v := range array(registry["policies"]) {
		ids = append(ids, str(object(v)["policyId"]))
	}
	rows, e := tx.Query(ctx, `SELECT DISTINCT p.value AS policy FROM runtime_config_events r
 CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.payload->'snapshot'->'qualificationRegistry'->'policies','[]'::jsonb)) p(value)
 WHERE r.endpoint=$1 AND r.component='api' AND p.value->>'policyId'=ANY($2::text[])`, endpoint, ids)
	if e != nil {
		return e
	}
	defer rows.Close()
	for rows.Next() {
		var old Object
		if e := rows.Scan(&old); e != nil {
			return e
		}
		for _, v := range array(registry["policies"]) {
			next := object(v)
			if old["policyId"] == next["policyId"] && old["policyVersion"] == next["policyVersion"] && old["definitionHash"] != next["definitionHash"] {
				return mismatch("Qualification policy version conflict: publish a new version")
			}
		}
	}
	return rows.Err()
}
func storeHonorVersions(ctx context.Context, tx pgx.Tx, endpoint, eventID string, rules []honorDefinition) error {
	for _, r := range rules {
		d := r.Definition
		_, e := tx.Exec(ctx, `INSERT INTO honor_rule_versions(endpoint,rule_id,rule_version,definition_hash,definition,introduced_config_id)
 VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(endpoint,rule_id,rule_version) DO NOTHING`, endpoint, d["id"], d["version"], r.Hash, jsonText(d), eventID)
		if e != nil {
			return e
		}
		var prior string
		if e = tx.QueryRow(ctx, "SELECT definition_hash FROM honor_rule_versions WHERE endpoint=$1 AND rule_id=$2 AND rule_version=$3", endpoint, d["id"], d["version"]).Scan(&prior); e != nil {
			return e
		}
		if prior != r.Hash {
			return mismatch("Honor rule version conflict: publish a new version")
		}
	}
	return nil
}
