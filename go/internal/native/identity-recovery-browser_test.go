package native

import (
	"context"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The independent browser keeps both synthetic codes in browser memory only;
// neither the script nor its output writes them to screenshots or logs.
func TestNativeRecoveryLocalBrowserJourney(t *testing.T) {
	ctx := context.Background()
	store, meta, transport := connectionServiceFixture(t)
	now := func() time.Time { return time.Unix(meta.Now, 0) }
	runtime, e := NewRuntime(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: now})
	if e != nil {
		t.Fatal(e)
	}
	defer runtime.Close()
	original, e := runtime.Restore(ctx)
	if e != nil {
		t.Fatal(e)
	}
	before, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	browser := NewBrowserChoices(store, nil)
	defer browser.Close()
	recovery := NewNativeRecovery(runtime)
	set, e := browser.recoveryPage(ctx, recovery, "set", "")
	if e != nil {
		t.Fatal(e)
	}
	restore, e := browser.recoveryPage(ctx, recovery, "recover", "")
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(hostJSONString(set), recoveryCodePrefix) || strings.Contains(hostJSONString(restore), recoveryCodePrefix) {
		t.Fatal("secret in tool result")
	}
	root, e := filepath.Abs("../../..")
	if e != nil {
		t.Fatal(e)
	}
	script := `import {chromium} from 'playwright';
let b,stage='launch';try{b=await chromium.launch({headless:true});const p=await b.newPage();p.setDefaultTimeout(4000);
stage='set-goto';await p.goto(process.argv[1]);stage='set-click';const [reply]=await Promise.all([p.waitForNavigation(),p.locator('button[value=prepare]').click()]);stage='set-code-http-'+reply.status()+'-prepare-failed-'+(await p.getByText('无法准备恢复码').count());const first=await p.locator('code').innerText();if(!first.startsWith('galaxy-recovery-v1:'))throw Error('missing original');stage='set-save';await p.locator('button[value=saved]').click();if(!await p.getByText('恢复码已登记').count())throw Error('set failed');
stage='recover';await p.goto(process.argv[2]);await p.locator('textarea[name=code]').fill(first);await p.locator('button[value=recover]').click();const next=await p.locator('code').innerText();if(!next.startsWith('galaxy-recovery-v1:')||next===first)throw Error('replacement missing');stage='next-save';await p.locator('button[value=saved]').click();if(!await p.getByText('恢复及保存声明已完成').count())throw Error('declaration failed');await b.close();process.stdout.write('ok');}catch{if(b)await b.close();process.stderr.write('browser stage '+stage);process.exitCode=1;}`
	timeout, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(timeout, "node", "--input-type=module", "-e", script, text(set["url"]), text(restore["url"]))
	cmd.Dir = root
	output, e := cmd.CombinedOutput()
	if e != nil || string(output) != "ok" {
		t.Fatalf("independent browser recovery failed: %v %s", e, output)
	}
	after, e := store.ChoiceScope(ctx)
	if e != nil || after.Owner != original.SubjectID || after.DeviceID == before.DeviceID {
		t.Fatal("browser did not recover same identity", after, e)
	}
	plan, e := runtime.PrepareConnect(ctx)
	if e != nil {
		t.Fatal("recovered connection plan", e)
	}
	if _, e = runtime.ConnectReviewed(ctx, plan, &after); e != nil {
		t.Fatal("recovered rebind", e)
	}
}
