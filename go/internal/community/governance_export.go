package community

import "fmt"

// ParseGovernance exposes the single existing schema to runtime audit readers.
// It grants no role and performs no review or signature authorization.
func ParseGovernance(config Object) (Object, error) { return parseGovernanceConfiguration(config) }

// ValidateGovernanceReviewRecord validates original recorded review metadata.
// Live runtime authorization continues to use VerifyGovernanceReview.
func ValidateGovernanceReviewRecord(record Object) error {
	copy := Object{}
	for key, value := range record {
		copy[key] = value
	}
	for _, key := range []string{"authoritiesSha256", "requestSignatureSha256", "reviewSignatureSha256"} {
		if !governanceSHA.MatchString(str(copy, key)) {
			return fmt.Errorf("invalid governance review record")
		}
		delete(copy, key)
	}
	_, err := parseGovernanceChange(copy)
	return err
}
