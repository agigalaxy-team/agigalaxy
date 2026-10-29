package operationsautonomy

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"os"
	"reflect"
	"testing"
)

func TestOriginalDutyAuthorityRejectionStatus(t *testing.T) {
	out, e := os.ReadFile("testdata/original-duty-errors.json")
	if e != nil {
		t.Fatal(e)
	}
	var expected Object
	if json.Unmarshal(out, &expected) != nil {
		t.Fatal("invalid source result")
	}
	s := &Service{Endpoint: "https://autonomy.example.invalid"}
	ctx := context.Background()
	errors := []error{}
	_, e = s.CurrentDutyWithin(ctx, nil, DutyInput{})
	errors = append(errors, e)
	_, e = s.RequireDutyAction(ctx, nil, Actor{}, "feedback.read", "")
	errors = append(errors, e)
	_, e = s.BindDutyOperationWithin(ctx, nil, Actor{}, DutyOperation{})
	errors = append(errors, e)
	_, e = s.ContinuationActorWithin(ctx, nil, Object{})
	errors = append(errors, e)
	actual := []Object{}
	for _, e := range errors {
		actual = append(actual, Object{"code": fault.Code(e), "status": fault.Status(e)})
	}
	var normalized any
	json.Unmarshal([]byte(jsonText(actual)), &normalized)
	if !reflect.DeepEqual(normalized, expected["errors"]) {
		t.Fatalf("authority rejection status Go%s JS%s", jsonText(actual), jsonText(expected))
	}
}
