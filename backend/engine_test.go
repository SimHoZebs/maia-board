package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func engineFixture(move string) EngineResult {
	wdl := [3]float64{.2, .2, .6}
	return EngineResult{Move: move, Candidates: []Candidate{{Move: move, Policy: 1, WDL: wdl}}, WDL: wdl}
}

type fakePredictor struct {
	result EngineResult
	err    error
	calls  int
	status WorkerStatus
}

func (f *fakePredictor) predict(context.Context, EngineRequest) (EngineResult, error) {
	f.calls++
	return f.result, f.err
}
func (f *fakePredictor) snapshot() WorkerStatus { return f.status }

func TestEnginePoolFallsBackPerRequest(t *testing.T) {
	large := &fakePredictor{err: errors.New("79m failed")}
	small := &fakePredictor{result: engineFixture("e2e4")}
	result, used, degraded, err := NewEnginePool(large, small).predict(context.Background(), "79m", EngineRequest{})
	if err != nil || used != "5m" || !degraded || result.Move != "e2e4" || large.calls != 1 || small.calls != 1 {
		t.Fatalf("fallback: %+v %s %t %v", result, used, degraded, err)
	}
}
func TestEnginePoolDoesNotFallbackForRequestErrors(t *testing.T) {
	for _, failure := range []error{ErrWorkerBusy, context.Canceled, context.DeadlineExceeded, ErrPositionMismatch, ErrInvalidPosition, ErrNoLegalMoves} {
		large, small := &fakePredictor{err: failure}, &fakePredictor{}
		_, _, _, err := NewEnginePool(large, small).predict(context.Background(), "79m", EngineRequest{})
		if !errors.Is(err, failure) || small.calls != 0 {
			t.Fatalf("fallback on %v", failure)
		}
	}
}
func TestEngineResultValidation(t *testing.T) {
	valid := engineFixture("e2e4")
	if !validEngineResult(valid, 1, true) {
		t.Fatal("valid result rejected")
	}
	for _, change := range []func(*EngineResult){
		func(r *EngineResult) { r.WDL = [3]float64{} },
		func(r *EngineResult) { r.Candidates[0].Policy = 2 },
		func(r *EngineResult) { r.Candidates[0].Move = "garbage" },
		func(r *EngineResult) { r.Candidates = append(r.Candidates, r.Candidates[0]) },
		func(r *EngineResult) { r.Move = "d2d4" },
	} {
		r := engineFixture("e2e4")
		change(&r)
		if validEngineResult(r, 1, true) {
			t.Fatalf("accepted %+v", r)
		}
	}
	valid.Move = "a2a3"
	if !validEngineResult(valid, 1, false) {
		t.Fatal("sampled move outside candidates rejected")
	}
}

// Re-exec the Go test binary as a persistent JSON-lines helper. The request's
// SelfElo selects a delay; OppoElo selects its unique answer, exposing cross-talk.
func TestPersistentMaiaHelper(t *testing.T) {
	if os.Getenv("MAIA_JSON_HELPER") != "1" {
		return
	}
	if os.Getenv("MAIA_JSON_SLOW_INIT") == "1" {
		_ = os.WriteFile(os.Getenv("MAIA_JSON_STARTED"), []byte(strconv.Itoa(os.Getpid())), 0600)
		time.Sleep(time.Minute)
	}
	fmt.Println(`{"ready":true}`)
	scanner := bufio.NewScanner(os.Stdin)
	calls := 0
	for scanner.Scan() {
		var r EngineRequest
		if json.Unmarshal(scanner.Bytes(), &r) != nil {
			os.Exit(2)
		}
		if path := os.Getenv("MAIA_JSON_STARTED"); path != "" {
			_ = os.WriteFile(path, []byte(strconv.Itoa(os.Getpid())), 0600)
		}
		calls++
		if path := os.Getenv("MAIA_JSON_CALLS"); path != "" {
			_ = os.WriteFile(path, []byte(strconv.Itoa(calls)), 0600)
		}
		if path := os.Getenv("MAIA_JSON_RELEASE"); path != "" {
			for {
				if _, err := os.Stat(path); err == nil {
					break
				}
				time.Sleep(time.Millisecond)
			}
		}
		if r.SelfElo == 4999 {
			time.Sleep(time.Minute)
		} else {
			time.Sleep(time.Duration(r.SelfElo) * time.Millisecond)
		}
		move := "e2e4"
		if r.OppoElo == 2 {
			move = "d2d4"
		}
		if r.OppoElo == 3 {
			fmt.Println(strings.Repeat("x", workerLineLimit+1))
			continue
		}
		if r.OppoElo == 4 {
			fmt.Println(`{"error":{"code":"invalid_position","message":"invalid board"}}`)
			continue
		}
		result := engineFixture(move)
		if r.OppoElo == 5 {
			result.Candidates[0].Policy = 2
		}
		if err := json.NewEncoder(os.Stdout).Encode(map[string]any{"result": result, "legal_count": 1}); err != nil {
			os.Exit(2)
		}
	}
	os.Exit(0)
}
func persistentWorker(t *testing.T) (*Worker, string) {
	t.Helper()
	t.Setenv("MAIA_JSON_HELPER", "1")
	path := filepath.Join(t.TempDir(), "started")
	t.Setenv("MAIA_JSON_STARTED", path)
	w := NewWorker("test", []string{os.Args[0], "-test.run=^TestPersistentMaiaHelper$"})
	w.startWait, w.moveWait = time.Second, 2*time.Second
	t.Cleanup(w.close)
	return w, path
}
func awaitPID(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(path)
		if err == nil {
			if pid, err := strconv.Atoi(string(data)); err == nil {
				return pid
			}
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("worker did not receive request")
	return 0
}
func TestCanceledCallerKeepsWarmWorkerAndSlot(t *testing.T) {
	w, path := persistentWorker(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	r := EngineRequest{FEN: startFEN, SelfElo: 400, OppoElo: 1}
	go func() { _, err := w.predict(ctx, r); done <- err }()
	pid := awaitPID(t, path)
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if len(w.slot) != 1 || w.snapshot().State != stateBusy {
		t.Fatal("canceled caller released slot")
	}
	if _, err := w.predict(context.Background(), EngineRequest{FEN: startFEN, OppoElo: 2}); !errors.Is(err, ErrWorkerBusy) {
		t.Fatalf("second request: %v", err)
	}
	// Joining the same operation drains its original response without rerunning.
	r.InitialFEN = startFEN // Equivalent explicit history root shares canonical identity.
	result, err := w.predict(context.Background(), r)
	if err != nil || result.Move != "e2e4" {
		t.Fatalf("join: %+v %v", result, err)
	}
	if len(w.slot) != 0 {
		t.Fatal("completed slot retained")
	}
	result, err = w.predict(context.Background(), EngineRequest{FEN: startFEN, OppoElo: 2})
	if err != nil || result.Move != "d2d4" {
		t.Fatalf("cross-talk: %+v %v", result, err)
	}
	w.mu.Lock()
	nextPID := w.proc.cmd.Process.Pid
	w.mu.Unlock()
	if nextPID != pid {
		t.Fatalf("warm PID changed: %d -> %d", pid, nextPID)
	}
}
func TestHardTimeoutKillsReapsAndReleases(t *testing.T) {
	w, path := persistentWorker(t)
	w.moveWait = 150 * time.Millisecond
	done := make(chan error, 1)
	go func() {
		_, err := w.predict(context.Background(), EngineRequest{FEN: startFEN, SelfElo: 4999})
		done <- err
	}()
	pid := awaitPID(t, path)
	if err := <-done; !errors.Is(err, ErrProtocol) {
		t.Fatalf("timeout: %v", err)
	}
	if len(w.slot) != 0 || w.snapshot().State != stateFailed {
		t.Fatal("hard timeout retained slot")
	}
	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("PID %d not reaped: %v", pid, err)
	}
	if _, err := w.predict(context.Background(), EngineRequest{FEN: startFEN, OppoElo: 2}); err != nil {
		t.Fatalf("recovery: %v", err)
	}
}
func TestWorkerRejectsOversizedResponse(t *testing.T) {
	w, _ := persistentWorker(t)
	if _, err := w.predict(context.Background(), EngineRequest{FEN: startFEN, OppoElo: 3}); !errors.Is(err, ErrProtocol) {
		t.Fatal(err)
	}
	if len(w.slot) != 0 {
		t.Fatal("slot leaked")
	}
}

func TestInitializationTimeoutKillsAndReaps(t *testing.T) {
	w, path := persistentWorker(t)
	t.Setenv("MAIA_JSON_SLOW_INIT", "1")
	w.startWait = 150 * time.Millisecond
	done := make(chan error, 1)
	go func() { _, err := w.predict(context.Background(), EngineRequest{FEN: startFEN}); done <- err }()
	pid := awaitPID(t, path)
	if err := <-done; !errors.Is(err, ErrProtocol) {
		t.Fatal(err)
	}
	if len(w.slot) != 0 {
		t.Fatal("initialization slot leaked")
	}
	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("initializing PID %d not reaped: %v", pid, err)
	}
}

func TestInvalidPositionResponseLeavesWarmWorkerReady(t *testing.T) {
	w, _ := persistentWorker(t)
	if _, err := w.predict(context.Background(), EngineRequest{FEN: startFEN, OppoElo: 4}); !errors.Is(err, ErrInvalidPosition) {
		t.Fatal(err)
	}
	w.mu.Lock()
	pid := w.proc.cmd.Process.Pid
	w.mu.Unlock()
	result, err := w.predict(context.Background(), EngineRequest{FEN: startFEN, OppoElo: 2})
	if err != nil || result.Move != "d2d4" {
		t.Fatalf("stale error: %+v %v", result, err)
	}
	w.mu.Lock()
	next := w.proc.cmd.Process.Pid
	w.mu.Unlock()
	if next != pid {
		t.Fatal("invalid position restarted worker")
	}
}
func TestSampledRequestsDoNotJoin(t *testing.T) {
	w, path := persistentWorker(t)
	request := EngineRequest{FEN: startFEN, SelfElo: 400, Temperature: .7}
	done := make(chan error, 1)
	go func() { _, err := w.predict(context.Background(), request); done <- err }()
	awaitPID(t, path)
	if _, err := w.predict(context.Background(), request); !errors.Is(err, ErrWorkerBusy) {
		t.Fatalf("sampled duplicate joined: %v", err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
func TestWorkerAcquireReturnsBusyWithoutStartingProcess(t *testing.T) {
	w := NewWorker("test", nil)
	w.slot <- struct{}{}
	if _, err := w.predict(context.Background(), EngineRequest{}); !errors.Is(err, ErrWorkerBusy) {
		t.Fatal(err)
	}
	<-w.slot
}
