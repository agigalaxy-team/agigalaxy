package messaging

import (
	"encoding/json"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestSMTPHostOriginalTrimAndUnicodeLowercase(t *testing.T) {
	hosts := []string{"\ufeff SMTP.EXAMPLE.INVALID \ufeff", "\u0085smtp.example.invalid\u0085", "İ.invalid", "K.invalid"}
	configs := []Object{}
	for _, host := range hosts {
		config := emptySMTPConfiguration()
		config["host"] = host
		configs = append(configs, config)
	}
	raw, _ := json.Marshal(configs)
	root, _ := filepath.Abs("../../..")
	script := `import{smtpConfigurationSchema}from './packages/galaxy-official/src/shared/operations-smtp-schema.mjs';console.log(JSON.stringify(JSON.parse(process.argv[1]).map(input=>{const p=smtpConfigurationSchema.safeParse(input);return p.success?{valid:true,configuration:p.data}:{valid:false,configuration:null}})))`
	cmd := exec.Command("node", "--input-type=module", "-e", script, string(raw))
	cmd.Dir = root
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatal(e)
	}
	var original []struct {
		Valid         bool
		Configuration Object
	}
	if e = json.Unmarshal(out, &original); e != nil {
		t.Fatal(e)
	}
	for i, input := range configs {
		configuration, e := ParseSMTPConfiguration(input)
		if (e == nil) != original[i].Valid || e == nil && !same(configuration, original[i].Configuration) {
			t.Errorf("host %d parser mismatch", i)
		}
	}
}
