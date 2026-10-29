package operationsstrategies

import (
	"context"
	"testing"
)

func TestOrdinaryCreationCopiesOnlyApprovedTemplate(t *testing.T) {
	config := sampleConfig()
	source := obj(list(config["strategies"])[0])
	obj(source["ordinaryBounds"])["canCreate"] = true
	config, err := ParseConfiguration(config)
	if err != nil {
		t.Fatal(err)
	}
	source = obj(list(config["strategies"])[0])
	input := Object{"sourceStrategyId": source["id"], "name": "新策略", "parameterEdits": []any{Object{"path": []any{0}, "value": 15}}}
	newID := "22222222-2222-4222-8222-222222222222"
	created, err := OrdinaryCreation(config, input, newID)
	if err != nil {
		t.Fatal(err)
	}
	rows := list(created["strategies"])
	if len(rows) != 2 || !same(rows[0], source) {
		t.Fatal("source strategy changed")
	}
	newStrategy := obj(rows[1])
	if newStrategy["id"] != newID || newStrategy["name"] != "新策略" || obj(newStrategy["ordinaryBounds"])["canCreate"] != false || num(leaf(newStrategy["condition"], []any{0})["value"]) != 15 {
		t.Fatalf("unexpected derived strategy: %v", newStrategy)
	}
	if !same(newStrategy["objective"], source["objective"]) || !same(newStrategy["execution"], source["execution"]) || !same(newStrategy["recovery"], source["recovery"]) {
		t.Fatal("source boundaries changed")
	}
	bad := deepClone(input)
	bad["parameterEdits"] = []any{Object{"path": []any{0}, "value": 21}}
	if _, err = OrdinaryCreation(config, bad, "33333333-3333-4333-8333-333333333333"); err == nil {
		t.Fatal("out-of-bounds edit accepted")
	}
	bad = deepClone(input)
	bad["sourceStrategyId"] = newID
	if _, err = OrdinaryCreation(created, bad, "33333333-3333-4333-8333-333333333333"); err == nil {
		t.Fatal("derived strategy recursively created")
	}
	obj(source["ordinaryBounds"])["canCreate"] = false
	if _, err = OrdinaryCreation(config, input, newID); err == nil {
		t.Fatal("missing human creation approval accepted")
	}
}

func TestOrdinaryCreateRequiresOpaqueDutyAtDomainEntry(t *testing.T) {
	service := &Service{}
	if _, err := service.PrepareOrdinary(context.Background(), Actor{}, "create-draft", Object{}); err == nil {
		t.Fatal("non-duty prepared create")
	}
	if _, err := service.CommandOrdinary(context.Background(), Actor{}, "create-draft", Object{}); err == nil {
		t.Fatal("non-duty executed create")
	}
}

func TestOrdinaryCatalogDescribesHumanApprovedDutyCreation(t *testing.T) {
	ordinary := obj(Catalog()["ordinaryMaintenance"])
	creation := obj(ordinary["creation"])
	if ordinary["scope"] != "existing-strategy-or-explicit-human-approved-template" || creation["kind"] != "ordinary-strategy-create-draft" || creation["surface"] != "duty-only" || creation["derivedCanCreate"] != false {
		t.Fatalf("creation catalog mismatch: %v", ordinary)
	}
}
