package operationsautonomy

import (
	"context"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	perms "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5"
)

type noticeAuthority struct {
	perms.Authority
	allowed bool
	action  string
}

func (a *noticeAuthority) RequireWithin(_ context.Context, _ pgx.Tx, actor Actor, action string) (Actor, error) {
	a.action = action
	if !a.allowed {
		return Actor{}, fault.New("operations_permission_denied", 403)
	}
	return actor, nil
}

func TestNoticeOriginalReceiptSourceAndCurrentPermission(t *testing.T) {
	op := "11111111-1111-4111-8111-111111111111"
	notice := "22222222-2222-4222-8222-222222222222"
	for _, tc := range []struct {
		name, kind, target, receiptID, state string
		want                                 bool
	}{
		{"create", "notice-draft-create", op, op, "completed", true},
		{"save", "notice-draft-save", notice, notice, "completed", true},
		{"publish", "notice-state", notice, notice, "completed", true},
		{"wrong-original-receipt", "notice-draft-save", notice, op, "completed", false},
		{"create-mismatched-target", "notice-draft-create", notice, notice, "completed", false},
		{"unknown-original-operation", "notice-draft-save", notice, "", "unknown", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			card := Object{"state": tc.state, "operation_id": op, "proposal": Object{"kind": tc.kind, "target": Object{"kind": "notice", "id": tc.target}}, "result": Object{"operationId": op, "state": tc.state, "receipt": Object{"noticeId": tc.receiptID, "version": 1, "private": "must not copy"}}}
			fact := WorkbenchCardFact(card)
			if !tc.want {
				if fact != nil {
					t.Fatalf("accepted invalid original receipt: %v", fact)
				}
				return
			}
			receipt := obj(fact["businessReceipt"])
			if receipt["targetType"] != "notice" || receipt["targetId"] != tc.target || receipt["operationId"] != op || receipt["details"] != nil {
				t.Fatalf("unexpected receipt: %v", receipt)
			}
		})
	}
	authority := &noticeAuthority{}
	service := &Service{Endpoint: "fixture", Authority: authority}
	row := Object{"domain": "messaging", "target_type": "notice", "target_id": notice}
	_, err := service.actor(context.Background(), nil, Actor{Endpoint: "fixture"}, "notices.read", nil)
	if fault.Status(err) != 403 {
		t.Fatalf("denied authority precondition: %v", err)
	}
	err = service.checkTargetWithin(context.Background(), nil, Actor{Endpoint: "fixture"}, row, false)
	if fault.Status(err) != 403 || authority.action != "notices.read" {
		t.Fatalf("notice source must require current notices.read: %v, %s", err, authority.action)
	}
	authority.allowed = true
	if err = service.checkTargetWithin(context.Background(), nil, Actor{Endpoint: "fixture"}, row, false); err != nil || authority.action != "notices.read" {
		t.Fatalf("authorized source: %v, %s", err, authority.action)
	}
	authority.allowed = false
	if err = service.checkTargetWithin(context.Background(), nil, Actor{Endpoint: "fixture"}, row, false); fault.Status(err) != 403 {
		t.Fatalf("revocation not rechecked: %v", err)
	}
}
