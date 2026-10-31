//go:build windows

package bootstrap

// isolateProcessOutput is a no-op on Windows: the observed stall comes from
// the unix test harness pipe behind the stderr descriptor and descriptor
// redirection is not portable there.
func isolateProcessOutput() (func(), error) {
	return func() {}, nil
}
