package evidence

// DescribeProof reuses the original v1 CI data schema and provenance checks.
// The facts-v2 extension validates its added fields separately, while signature
// verification continues to consume the original token bytes through its owner.
func DescribeProof(data any) (Object, error) { return describeProof(data) }
