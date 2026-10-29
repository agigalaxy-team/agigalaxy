package operationsqueries

import "testing"

func TestContentTagExactReadUsesOwnPermission(t *testing.T) {
	args, e := parse("read-operation-object", Object{"kind": "content-tag", "id": "7f8fb2cc-c1ad-40a7-9078-d0054bf1a916", "filters": Object{}})
	if e != nil {
		t.Fatal(e)
	}
	if readAction(args) != "content.tags.read" {
		t.Fatal("tag read must use tags permission")
	}
}
