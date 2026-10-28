//go:build perf

package bootstrap

import (
	"testing"
	"time"
)

// TestDesktopColdOpenBudget enforces the strict 5s fresh-local-Open wall-clock
// budget. Go's default parallel package execution competes for CPU and disk
// even on an otherwise idle machine, so a wall-clock assertion in the default
// suite is randomly red regardless of Open's real cost. This test therefore
// lives behind the explicit perf build tag and is run under controlled serial
// conditions (one package, one test):
//
//	go test ./internal/bootstrap -tags=perf -run TestDesktopColdOpenBudget -count=1 -v
func TestDesktopColdOpenBudget(t *testing.T) {
	measured := measureFreshLocalOpen(t)
	if calls := measured.outboundCalls; calls != 0 {
		t.Fatalf("fresh local startup made %d outbound requests", calls)
	}
	if measured.openDuration > 5*time.Second {
		t.Fatalf("fresh local Open took %s, budget is 5s", measured.openDuration)
	}
	t.Logf("local_open_ms=%d budget_ms=5000 idle_outbound_requests=0", measured.openDuration.Milliseconds())
}
