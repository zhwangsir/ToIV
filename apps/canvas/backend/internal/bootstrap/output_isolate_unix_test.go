//go:build !windows

package bootstrap

import (
	"fmt"
	"os"
	"sync"
	"syscall"
)

// isolateProcessOutput points the process output descriptors at the null
// device until restore runs. It keeps timed Open measurements independent of
// how quickly the `go test` harness drains the captured pipe; GORM's
// slow-query logger writes full SQL text synchronously to stderr and can
// otherwise block inside the measured window. restore is idempotent.
func isolateProcessOutput() (restore func(), err error) {
	devNull, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		return nil, err
	}
	closeAll := func(savedOut, savedErr int) {
		_ = syscall.Close(savedOut)
		_ = syscall.Close(savedErr)
		_ = devNull.Close()
	}
	savedOut, err := syscall.Dup(1)
	if err != nil {
		_ = devNull.Close()
		return nil, err
	}
	savedErr, err := syscall.Dup(2)
	if err != nil {
		_ = syscall.Close(savedOut)
		_ = devNull.Close()
		return nil, err
	}
	if err := syscall.Dup2(int(devNull.Fd()), 1); err != nil {
		closeAll(savedOut, savedErr)
		return nil, fmt.Errorf("redirect stdout: %w", err)
	}
	if err := syscall.Dup2(int(devNull.Fd()), 2); err != nil {
		_ = syscall.Dup2(savedOut, 1)
		closeAll(savedOut, savedErr)
		return nil, fmt.Errorf("redirect stderr: %w", err)
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			_ = syscall.Dup2(savedOut, 1)
			_ = syscall.Dup2(savedErr, 2)
			closeAll(savedOut, savedErr)
		})
	}, nil
}
