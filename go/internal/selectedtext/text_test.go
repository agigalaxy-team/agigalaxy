package selectedtext

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestOriginalSelectedTextUTF16AndCredentialPatterns(t *testing.T) {
	values := []string{"", strings.Repeat("😀", 2000), strings.Repeat("😀", 2001), strings.Repeat("😀", 4000), strings.Repeat("😀", 4001), "password=😀😀😀😀", "password=😀😀😀", "Bearer\u2028ABCDEFGHIJKLMNOP", "API_KEY\u00a0:\u3000abcdefgh", "paſſword=abcdefgh", "ſk-ABCDEFGHIJKLMNOPQRST", "sk-ABCDEFGHIJKLMNOPQRST", "-----BEGIN RSA PRIVATE KEY-----", "ordinary selected text", "github_pat_a", "aBearer abcdefghijklmnop", " Bearer abcdefghijklmnop"}
	root, _ := filepath.Abs("../../..")
	raw, _ := json.Marshal(values)
	cmd := exec.Command("node", "--input-type=module", "-e", `import {selectedTextSchema} from './packages/galaxy-contracts/src/context-schema.mjs';let raw='';for await(const b of process.stdin)raw+=b;console.log(JSON.stringify(JSON.parse(raw).map(s=>selectedTextSchema.safeParse(s).success)))`)
	cmd.Dir = root
	cmd.Stdin = bytes.NewReader(raw)
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original selectedText %v %s", e, out)
	}
	var expected []bool
	if json.Unmarshal(out, &expected) != nil {
		t.Fatal("oracle response")
	}
	for i, value := range values {
		if got := Valid(value); got != expected[i] {
			t.Fatalf("case %d expected %v got %v", i, expected[i], got)
		}
	}
}
