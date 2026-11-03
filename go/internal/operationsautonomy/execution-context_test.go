package operationsautonomy

import "testing"

func TestAssignmentExecutionAndSchedulerAreSeparate(t *testing.T) {
	for _, kind := range []string{"interval", "daily", "event"} {
		row := Object{"id": "invocation", "source": "routine", "config_id": "routine"}
		cfg := Object{"goal": "Observe future changes indefinitely", "schedule": Object{"kind": kind}}
		value := executionContext(row, cfg)
		if obj(value["assignment"])["objective"] != cfg["goal"] || obj(value["execution"])["objective"] == cfg["goal"] || obj(value["scheduler"])["owner"] != "server" {
			t.Fatalf("mixed work lifetimes: %#v", value)
		}
		cfg["executionGoal"] = "Analyze current evidence and apply permitted actions"
		if obj(executionContext(row, cfg)["execution"])["objective"] != cfg["executionGoal"] {
			t.Fatal("explicit per-activation work lost")
		}
	}
	row := Object{"id": "one", "source": "workbench"}
	cfg := Object{"goal": "Complete this concrete work", "schedule": Object{"kind": "interval"}}
	if obj(executionContext(row, cfg)["execution"])["objective"] != cfg["goal"] {
		t.Fatal("interactive task changed into recurring work")
	}
}

func TestFutureWorkIsSeparateFromExecutionAssessment(t *testing.T) {
	args := Object{"scope": "execution", "goalSatisfied": true, "remainingWork": []any{}, "deferredWork": []any{"Check after the next event"}, "summary": "Current work delivered"}
	if err := parseAssessment(args); err != nil {
		t.Fatal(err)
	}
	args["scope"] = "assignment"
	if err := parseAssessment(args); err == nil {
		t.Fatal("assignment lifetime accepted as current execution assessment")
	}
}
