package civ2

import "github.com/agigalaxy-team/agigalaxy/go/internal/protocol"

// DescribeProof applies the existing facts-v2 data and provenance checks. It
// does not verify a remote signature or grant access to its referenced sources.
func DescribeProof(data any) (Object, error) { return describe(data) }

// ParseProof validates the same data while retaining the caller's original
// signed bytes outside this function. No proof is generated or re-signed.
func ParseProof(raw []byte) (Object, error) {
	data, err := protocol.DecodeOrdered(raw)
	if err != nil {
		return nil, err
	}
	if _, err = describe(data); err != nil {
		return nil, err
	}
	return obj(data), nil
}
