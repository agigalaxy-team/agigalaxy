package community

import (
	"context"
	"testing"
)

func TestPublicActivityWithMissingPermissionIsNotCounted(t *testing.T) {
	service := &Service{}
	for _, kind := range []string{"post", "reply"} {
		allowed, err := service.ActivityAllowedWithin(context.Background(), nil, kind, "post", "source", "", "hash", 0)
		if err != nil || allowed {
			t.Fatalf("%s without a permission: allowed=%v err=%v", kind, allowed, err)
		}
	}
}
