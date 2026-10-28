package taskmaterials

import "github.com/agigalaxy-team/agigalaxy/go/internal/protocol"

// SelectedTextViewWire serializes an already-authorized selected-field material
// projection. It restores only the owning original DTO order, never permission.
func SelectedTextViewWire(view Object, fieldOrder []string) *protocol.OrderedObject {
	fields := obj(view, "fields")
	ordered := protocol.NewOrderedObject()
	for _, field := range fieldOrder {
		if value, ok := fields[field]; ok {
			ordered.Set(field, historyTextField(value.(map[string]any)))
		}
	}
	return taskOrdered("format", view["format"], "checkedAt", view["checkedAt"], "fields", ordered)
}
