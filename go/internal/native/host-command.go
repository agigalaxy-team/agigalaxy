package native

import (
    "os"
    "os/exec"
    "path/filepath"
    "regexp"
    "runtime"
    "strings"

    "github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

// Resolve an npm Windows shim to its Node entry without interpreting shell text.
// The shim is supplied by the user's installed host, and its script path is
// resolved relative to that shim exactly as npm's %dp0% expansion does.
func resolveHostCommand(name, supplied string)(string,[]string,error){
 if supplied=="" { path,e:=exec.LookPath(name);if e!=nil{return "",nil,fault.New("host_model_execution_unavailable",409)};supplied=path }
 if !filepath.IsAbs(supplied){return "",nil,fault.New("host_model_execution_unavailable",409)}
 ext:=strings.ToLower(filepath.Ext(supplied))
 if runtime.GOOS!="windows" || ext!=".cmd" && ext!=".bat" {return supplied,nil,nil}
 raw,e:=os.ReadFile(supplied);if e!=nil||len(raw)>131072{return "",nil,fault.New("host_model_execution_unavailable",409)}
 pattern:=regexp.MustCompile(`(?i)(%~dp0|%dp0%)[\\/]([^\r\n"']+?\.(c|m)?js)`)
 matches:=pattern.FindAllStringSubmatch(string(raw),-1)
 for _,match:=range matches {
  relative:=strings.ReplaceAll(match[2],"/",string(filepath.Separator))
  script:=filepath.Clean(filepath.Join(filepath.Dir(supplied),relative))
  info,err:=os.Stat(script);if err!=nil||!info.Mode().IsRegular(){continue}
  node:=filepath.Join(filepath.Dir(supplied),"node.exe")
  if info,err=os.Stat(node);err!=nil||!info.Mode().IsRegular(){node,err=exec.LookPath("node");if err!=nil{continue}}
  return node,[]string{script},nil
 }
 return "",nil,fault.New("host_model_execution_unavailable",409)
}


// ResolveHostCommand resolves an installed host command or npm Windows shim to
// an executable and argv prefix without evaluating the shim as shell code.
func ResolveHostCommand(name, supplied string) (string, []string, error) {
 return resolveHostCommand(name, supplied)
}
