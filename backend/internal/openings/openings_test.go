package openings

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// TestOpeningsServeHelper is not a test: re-executed as the warm helper
// process, it speaks the --serve protocol (ready marker, one JSON line per
// lookup) so worker tests never need Python.
func TestOpeningsServeHelper(t *testing.T) {
	if os.Getenv("OPENINGS_SERVE_HELPER") != "1" {
		return
	}
	fmt.Println(`{"ready":true}`)
	reader := bufio.NewReader(os.Stdin)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return
		}
		fmt.Printf("{\"pid\":%d,\"echo\":%s}\n", os.Getpid(), strings.TrimSpace(line))
	}
}

func warmTestLookup(t *testing.T) *OpeningsLookup {
	t.Helper()
	t.Setenv("OPENINGS_SERVE_HELPER", "1")
	lookup := NewOpeningsLookup(os.Args[0], "-test.run=^TestOpeningsServeHelper$")
	// Drop the python-only --serve flag: the helper speaks the protocol
	// unconditionally when the env var is set.
	lookup.command = lookup.command[:2]
	lookup.timeout = 5 * time.Second
	return lookup
}

func TestWarmWorkerServesSequentialQueriesFromOneProcess(t *testing.T) {
	lookup := warmTestLookup(t)
	var pids []int
	for _, moves := range []string{`{"moves":["e2e4"]}`, `{"moves":["d2d4"]}`} {
		out, err := lookup.run(context.Background(), lookup.command, []byte(moves))
		if err != nil {
			t.Fatal(err)
		}
		var body struct {
			PID int `json:"pid"`
		}
		if err := json.Unmarshal(out, &body); err != nil {
			t.Fatalf("helper output is not JSON: %v (%s)", err, out)
		}
		pids = append(pids, body.PID)
	}
	if len(pids) != 2 || pids[0] != pids[1] {
		t.Fatalf("sequential queries forked per request: %v", pids)
	}
}

func TestWarmWorkerRejectsOversizeInputWithoutFork(t *testing.T) {
	lookup := warmTestLookup(t)
	if _, err := lookup.run(context.Background(), lookup.command, []byte(`{"moves":["`+strings.Repeat("e2e4,", 20000)+`"]}`)); err == nil {
		t.Fatal("oversize input accepted")
	}
	lookup.mu.Lock()
	defer lookup.mu.Unlock()
	if lookup.proc != nil {
		t.Fatal("oversize input started the helper")
	}
}

func TestWarmWorkerRestartsDeadHelper(t *testing.T) {
	lookup := warmTestLookup(t)
	if _, err := lookup.run(context.Background(), lookup.command, []byte(`{"moves":[]}`)); err != nil {
		t.Fatal(err)
	}
	lookup.mu.Lock()
	first := lookup.proc
	lookup.mu.Unlock()
	if first == nil {
		t.Fatal("first query started no helper")
	}
	lookup.mu.Lock()
	lookup.failLocked()
	lookup.mu.Unlock()
	if _, err := lookup.run(context.Background(), lookup.command, []byte(`{"moves":[]}`)); err != nil {
		t.Fatalf("query after helper death: %v", err)
	}
	lookup.mu.Lock()
	defer lookup.mu.Unlock()
	if lookup.proc == nil || lookup.proc == first {
		t.Fatal("dead helper was not replaced")
	}
}
