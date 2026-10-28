package bootstrap

import (
	"context"
	"errors"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

type outboundCounter struct{ calls atomic.Int64 }

func (c *outboundCounter) RoundTrip(*http.Request) (*http.Response, error) {
	c.calls.Add(1)
	return nil, errors.New("unexpected outbound request during local startup")
}

// coldOpenMeasurement is one fresh-desktop-Open probe: the wall-clock duration
// of Open and the outbound request count observed across Open, Start and a
// short idle window.
type coldOpenMeasurement struct {
	openDuration  time.Duration
	outboundCalls int64
}

// measureFreshLocalOpen runs the cold-open probe exactly once. It is shared by
// the default no-idle-outbound test and the perf-tagged budget test so the
// Open orchestration lives in one place.
func measureFreshLocalOpen(t *testing.T) coldOpenMeasurement {
	t.Helper()
	counter := &outboundCounter{}
	previous := http.DefaultTransport
	http.DefaultTransport = counter
	defer func() { http.DefaultTransport = previous }()
	// The sample must measure Open's work, not the test harness's output drain:
	// the GORM slow-query logger synchronously emits full SQL text on stderr
	// (the plugin registry seed alone is ~2MB), and during a parallel
	// `go test ./...` that pipe is read slowly enough to stall inside the
	// measured window. Point the output descriptors at the null device for the
	// duration of the call and restore them right after.
	restore, err := isolateProcessOutput()
	if err != nil {
		t.Fatal(err)
	}
	defer restore()
	dataDir := t.TempDir()
	started := time.Now()
	runtime, err := Open(context.Background(), Config{Profile: ProfileDesktop, DataDir: dataDir, ListenAddr: "127.0.0.1:0", AutoMigrate: true})
	openDuration := time.Since(started)
	restore()
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.Start(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if err := runtime.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	return coldOpenMeasurement{openDuration: openDuration, outboundCalls: counter.calls.Load()}
}

// TestDesktopColdOpenNoIdleOutbound proves the functional invariant on every
// default run: a fresh local startup issues zero outbound requests while idle.
// The wall-clock duration is logged as a sample only. The strict 5s cold-open
// budget is a performance assertion and is verified separately under
// controlled serial conditions by:
//
//	go test ./internal/bootstrap -tags=perf -run TestDesktopColdOpenBudget -count=1 -v
func TestDesktopColdOpenNoIdleOutbound(t *testing.T) {
	measured := measureFreshLocalOpen(t)
	if calls := measured.outboundCalls; calls != 0 {
		t.Fatalf("fresh local startup made %d outbound requests", calls)
	}
	t.Logf("local_open_ms=%d idle_outbound_requests=0", measured.openDuration.Milliseconds())
}
