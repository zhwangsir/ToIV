package main

import (
	"strings"
	"testing"
)

func TestDesktopRejectsCLICommands(t *testing.T) {
	for _, args := range [][]string{{"mcp", "serve"}, {"ops", "--json"}, {"canvas", "get"}, {"client", "register"}, {"unknown-command"}, {"--json", "mcp", "serve"}} {
		err := validateDesktopArgs(args)
		if err == nil {
			t.Fatalf("desktop accepted CLI arguments %v", args)
		}
		msg := err.Error()
		if strings.Contains(msg, "BeefTV") {
			t.Fatalf("error still brands BeefTV for %v: %q", args, msg)
		}
		if !strings.Contains(msg, "ToIV") {
			t.Fatalf("error missing ToIV brand for %v: %q", args, msg)
		}
	}
	for _, args := range [][]string{nil, {"-psn_0_12345"}, {"--disable-gpu"}, {"--user-data-dir=platform-profile"}, {"-NSDocumentRevisionsDebugMode", "YES"}, {"-AppleLanguages", "(en)"}} {
		if err := validateDesktopArgs(args); err != nil {
			t.Fatalf("desktop rejected platform arguments %v: %v", args, err)
		}
	}
}
