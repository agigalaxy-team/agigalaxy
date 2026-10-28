package operationspermissions

// AutomationResourceScope retains the original selected/eligible/legacy-empty
// distinction for consumers of committed grants. It grants no authority.
func AutomationResourceScope(row Object) Object { return automationScope(row) }
