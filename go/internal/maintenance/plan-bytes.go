package maintenance

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

func sameValues(a, b any) bool {
	x, e := identity.Canonical([]any{a})
	y, f := identity.Canonical([]any{b})
	return e == nil && f == nil && string(x) == string(y)
}
func ordered(o Object, keys ...string) *protocol.OrderedObject {
	out := protocol.NewOrderedObject()
	for _, k := range keys {
		out.Set(k, o[k])
	}
	return out
}
func orderedCoverage(rows any) []any {
	out := []any{}
	for _, v := range list(rows) {
		out = append(out, ordered(obj(v), "id", "label", "kind", "required", "state", "method", "sourceIds", "postgresStanzas", "reasonCodes", "existenceAtOlderPoint"))
	}
	return out
}

// The original plan digest hashes JSON.stringify insertion order. PostgreSQL
// JSONB order and canonical JSON are intentionally not substituted for it.
func PlanDigest(plan Object) (string, error) {
	point := clone(obj(plan["point"]))
	point["integrity"] = ordered(obj(point["integrity"]), "state", "checkedAt")
	point["coverage"] = orderedCoverage(point["coverage"])
	point["capture"] = ordered(obj(point["capture"]), "state", "startedAt", "finishedAt", "consistency")
	point["productionRestore"] = ordered(obj(point["productionRestore"]), "available", "blockers")
	value := clone(plan)
	value["point"] = ordered(point, "id", "createdAt", "captureId", "logicalBytes", "logicalFileCount", "sizeBasis", "integrity", "coverage", "capture", "productionRestore")
	value["modules"] = orderedCoverage(plan["modules"])
	value["preservedCurrent"] = ordered(obj(plan["preservedCurrent"]), "state", "items", "basis")
	value["possibleLoss"] = ordered(obj(plan["possibleLoss"]), "from", "to", "observedWindowSeconds", "maximumSeconds", "through", "basis")
	conditions := []any{}
	for _, v := range list(plan["openingConditions"]) {
		conditions = append(conditions, ordered(obj(v), "id", "state"))
	}
	value["openingConditions"] = conditions
	raw, e := protocol.EncodeJS(ordered(value, "version", "scope", "point", "moduleIds", "modules", "footprintDigest", "adapterVersion", "preservedCurrent", "possibleLoss", "openingConditions", "blockers"))
	if e != nil {
		return "", e
	}
	return identity.Digest(raw), nil
}
