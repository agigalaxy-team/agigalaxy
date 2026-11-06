package communitygrowth

import (
	"math"
	"testing"
)

func TestAssessmentResultSeparatesMissingEvidenceFromLowValue(t *testing.T) {
	zero := float64(0)
	result := AssessmentResult{AccountID: "account", Domain: "technology", Purpose: "evaluation-reference", InputRevision: 1, ConfigVersion: 1,
		Status: "insufficient-material", Coverage: "none", Reason: "缺少实际评价结果的依据", Missing: []string{"尚无可比较的评价表现"}}
	if !validAssessmentResult(result) {
		t.Fatal("missing evidence must have a neutral, unassessed representation")
	}
	result.Value = &zero
	if validAssessmentResult(result) {
		t.Fatal("missing evidence was allowed to become zero reputation")
	}
	result.Status, result.Coverage = "assessed", "partial"
	if validAssessmentResult(result) {
		t.Fatal("assessed weight without traceable evidence was accepted")
	}
	result.Evidence = []AssessmentEvidence{{SourceKey: "source", SourceRevision: 1, SourceVersion: "version"}}
	if !validAssessmentResult(result) {
		t.Fatal("a grounded low assessment must remain distinguishable from no judgment")
	}
	nan := math.NaN()
	result.Value = &nan
	if validAssessmentResult(result) {
		t.Fatal("non-finite model output was accepted")
	}
	result.Value = &zero
	result.Evidence = append(result.Evidence, result.Evidence[0])
	if validAssessmentResult(result) {
		t.Fatal("one source was allowed to count as duplicate evidence")
	}
}
