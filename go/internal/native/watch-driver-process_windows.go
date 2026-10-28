package native

import "os"

func watchDriverTerminate(process *os.Process) error { return process.Kill() }
