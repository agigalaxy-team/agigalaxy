package messaging

import (
	"encoding/json"
	"os"
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
	out, e := os.ReadFile(filepath.Join("testdata", "smtp-host-original.json"))
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
