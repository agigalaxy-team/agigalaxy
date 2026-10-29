package operationsqueries

import "testing"

func TestPreparationProjectionPreservesUnknownAndDirectExecutionBoundary(t *testing.T) {
	file := Object{"id": "file-1", "canRetryScan": true, "access": Object{"canStop": false, "canRestore": false, "stopped": false, "preparationEligibility": Object{"stop": true, "restore": false, "basis": "human-confirmation-preparation"}}}
	known := fileItemPreparation(file, true)
	if known["canRetryScan"] != true || known["capabilityBasis"] != "human-confirmation-preparation" || known["executionAuthorized"] != false {
		t.Fatalf("known file %#v", known)
	}
	access := object(known["access"])
	if access["canStop"] != nil || access["canRestore"] != nil || access["capabilityBasis"] != "direct-execution-only" || object(access["preparationEligibility"])["stop"] != true || object(access["preparationEligibility"])["restore"] != false {
		t.Fatalf("file boundary %#v", access)
	}
	unknown := fileItemPreparation(file, false)
	if unknown["canRetryScan"] != nil || unknown["executionAuthorized"] != nil || object(object(unknown["access"])["preparationEligibility"])["stop"] != nil {
		t.Fatalf("duty file %#v", unknown)
	}
	data := Object{"handling": Object{"canModerate": true, "knownPartyConflict": false}}
	projectCasePreparation(data, true)
	if object(data["handling"])["canModerate"] != true || object(data["handling"])["executionAuthorized"] != false {
		t.Fatalf("case %#v", data)
	}
	projectCasePreparation(data, false)
	if object(data["handling"])["canModerate"] != nil || object(data["handling"])["executionAuthorized"] != nil {
		t.Fatalf("duty case %#v", data)
	}
	strategy := strategyRunItem(Object{"canContinue": false, "continueCode": "permission-denied", "capabilityPurpose": "human-confirmation-preparation"}, true)
	if strategy["canContinue"] != false || strategy["capabilityPurpose"] != "human-confirmation-preparation" || strategy["executionAuthorized"] != false {
		t.Fatalf("strategy %#v", strategy)
	}
	strategy = strategyRunItem(Object{"canContinue": false, "continueCode": "permission-denied"}, false)
	if strategy["canContinue"] != nil || strategy["continueCode"] != nil || strategy["executionAuthorized"] != nil {
		t.Fatalf("duty strategy %#v", strategy)
	}
}
