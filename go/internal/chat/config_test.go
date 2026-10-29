package chat

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestTransportConfigurationOriginalHashAndFileBoundaries(t *testing.T) {
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	dir := t.TempDir()
	secretFile := filepath.Join(dir, "component-\u2028.key")
	if e := os.WriteFile(secretFile, []byte("  "+testSecret+"\n"), 0600); e != nil {
		t.Fatal(e)
	}
	config := Configuration{1, "xmpp://127.0.0.1:5347", "gateway<&>\u2028.example.invalid", "rooms.example.invalid", secretFile}
	path := filepath.Join(dir, "chat.json")
	if e := os.WriteFile(path, encode(config), 0600); e != nil {
		t.Fatal(e)
	}
	transport, hash, e := LoadTransport(path)
	if e != nil || hash == nil || transport.Available() {
		t.Fatalf("load: %v %v", hash, e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "node", "--input-type=module", "-e", `import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';const x=JSON.parse(await readFile(process.argv[1],'utf8'));console.log(JSON.stringify({hash:createHash('sha256').update(JSON.stringify(x)).digest('hex')}));`, path)
	command.Dir = root
	out, e := command.Output()
	if e != nil {
		if ee, ok := e.(*exec.ExitError); ok {
			t.Fatalf("independent JSON bytes: %v %s", e, ee.Stderr)
		}
		t.Fatal(e)
	}
	var oracle Object
	if e = json.Unmarshal(out, &oracle); e != nil {
		t.Fatal(e)
	}
	if *hash != str(oracle, "hash") {
		t.Fatalf("configuration hash differs from JSON.stringify: %s %s", *hash, oracle["hash"])
	}
	for _, service := range []string{"https://127.0.0.1:5347", "xmpp://remote.example.invalid:5347", "xmpp://user@localhost:5347", "xmpp://localhost:5347/path", "xmpp://localhost:5347?query=yes"} {
		config.Service = service
		os.WriteFile(path, encode(config), 0600)
		if _, _, e = LoadTransport(path); e == nil {
			t.Fatalf("accepted remote/noncomponent address %q", service)
		}
	}
	if _, _, e = LoadTransport("relative.json"); e == nil {
		t.Fatal("relative configuration accepted")
	}
	if tr, h, e := LoadTransport(""); e != nil || tr != nil || h != nil {
		t.Fatal("optional empty path changed")
	}
}
