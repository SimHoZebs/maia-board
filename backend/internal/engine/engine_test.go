package engine

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

	"maia-board/backend/internal/ipc"
	"maia-board/backend/internal/sched"
)

const startFEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

func engineFixture(move string) MaiaResult {
	wdl := [3]float64{.2, .2, .6}
	return MaiaResult{Move: move, Candidates: []MaiaCandidate{{Move: move, Policy: 1, WDL: wdl}}, WDL: wdl}
}

type fakePredictor struct {
	result MaiaResult
	err    error
	calls  int
	status WorkerStatus
}

func (f *fakePredictor) Predict(_, _ context.Context, _ sched.Priority, _ uint64, _ MaiaRequest) (MaiaResult, func(), error) {
	f.calls++
	return f.result, nil, f.err
}
func (f *fakePredictor) WorkerStatus() WorkerStatus { return f.status }

func TestEnginePoolFallsBackPerRequest(t *testing.T) {
	large := &fakePredictor{err: errors.New("79m failed")}
	small := &fakePredictor{result: engineFixture("e2e4")}
	result, _, used, degraded, err := NewEnginePool(large, small).Predict(context.Background(), context.Background(), sched.PriorityFocus, 0, "79m", MaiaRequest{})
	if err != nil || used != "5m" || !degraded || result.Move != "e2e4" || large.calls != 1 || small.calls != 1 {
		t.Fatalf("fallback: %+v %s %t %v", result, used, degraded, err)
	}
}
func TestEnginePoolDoesNotFallbackForRequestErrors(t *testing.T) {
	for _, failure := range []error{ErrWorkerBusy, ErrJoined, sched.ErrSuperseded, context.Canceled, context.DeadlineExceeded, ErrPositionMismatch, ErrInvalidPosition, ErrNoLegalMoves} {
		large, small := &fakePredictor{err: failure}, &fakePredictor{}
		_, _, _, _, err := NewEnginePool(large, small).Predict(context.Background(), context.Background(), sched.PriorityFocus, 0, "79m", MaiaRequest{})
		if !errors.Is(err, failure) || small.calls != 0 {
			t.Fatalf("fallback on %v", failure)
		}
	}
}
func TestMaiaResultValidation(t *testing.T) {
	valid := engineFixture("e2e4")
	if !validEngineResult(valid, 1, true) {
		t.Fatal("valid result rejected")
	}
	for _, change := range []func(*MaiaResult){
		func(r *MaiaResult) { r.WDL = [3]float64{} },
		func(r *MaiaResult) { r.Candidates[0].Policy = 2 },
		func(r *MaiaResult) { r.Candidates[0].Move = "garbage" },
		func(r *MaiaResult) { r.Candidates = append(r.Candidates, r.Candidates[0]) },
		func(r *MaiaResult) { r.Move = "d2d4" },
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
		var r MaiaRequest
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
			fmt.Println(strings.Repeat("x", ipc.LineLimit+1))
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
	t.Cleanup(w.Close)
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
	oldWait := SyncWaitFocus
	SyncWaitFocus = 100 * time.Millisecond
	defer func() { SyncWaitFocus = oldWait }()
	w, path := persistentWorker(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	r := MaiaRequest{FEN: startFEN, SelfElo: 400, OppoElo: 1}
	go func() {
		_, release, err := w.Predict(ctx, ctx, sched.PriorityFocus, 0, r)
		if release != nil {
			release()
		}
		done <- err
	}()
	pid := awaitPID(t, path)
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if w.WorkerStatus().State != stateBusy {
		t.Fatal("canceled caller released slot")
	}
	// A different position waits for the drain, then reports busy: it must
	// not cut in front of the running operation.
	if _, _, err := w.Predict(context.Background(), context.Background(), sched.PriorityFocus, 0, MaiaRequest{FEN: startFEN, OppoElo: 2}); !errors.Is(err, ErrWorkerBusy) {
		t.Fatalf("second request: %v", err)
	}
	// The same deterministic work joins instead of inferring twice. The join
	// waits on the owner, so it gets a generous budget here.
	r.InitialFEN = startFEN // Equivalent explicit history root shares canonical identity.
	SyncWaitFocus = 10 * time.Second
	if _, _, err := w.Predict(context.Background(), context.Background(), sched.PriorityFocus, 0, r); !errors.Is(err, ErrJoined) {
		t.Fatalf("duplicate: %v", err)
	}
	// The drain owns the slot until the reply lands; afterwards the warm
	// process serves fresh work.
	deadline := time.Now().Add(10 * time.Second)
	for !w.sched.Idle() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !w.sched.Idle() {
		t.Fatal("drain retained slot")
	}
	result, err := predictSync(t, w, r)
	if err != nil || result.Move != "e2e4" {
		t.Fatalf("re-infer: %+v %v", result, err)
	}
	result, err = predictSync(t, w, MaiaRequest{FEN: startFEN, OppoElo: 2})
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

// predictSync runs one inference and releases the slot, mirroring the
// handler's release-after-store discipline (tests have nothing to store).
func predictSync(t *testing.T, w *Worker, r MaiaRequest) (MaiaResult, error) {
	t.Helper()
	result, release, err := w.Predict(context.Background(), context.Background(), sched.PriorityFocus, 0, r)
	if release != nil {
		release()
	}
	return result, err
}
func TestHardTimeoutKillsReapsAndReleases(t *testing.T) {
	w, path := persistentWorker(t)
	w.moveWait = 150 * time.Millisecond
	done := make(chan error, 1)
	go func() {
		_, release, err := w.Predict(context.Background(), context.Background(), sched.PriorityFocus, 0, MaiaRequest{FEN: startFEN, SelfElo: 4999})
		if release != nil {
			release()
		}
		done <- err
	}()
	pid := awaitPID(t, path)
	if err := <-done; !errors.Is(err, ErrProtocol) {
		t.Fatalf("timeout: %v", err)
	}
	if !w.sched.Idle() || w.WorkerStatus().State != stateFailed {
		t.Fatal("hard timeout retained slot")
	}
	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("PID %d not reaped: %v", pid, err)
	}
	if _, err := predictSync(t, w, MaiaRequest{FEN: startFEN, OppoElo: 2}); err != nil {
		t.Fatalf("recovery: %v", err)
	}
}
func TestWorkerRejectsOversizedResponse(t *testing.T) {
	w, _ := persistentWorker(t)
	if _, err := predictSync(t, w, MaiaRequest{FEN: startFEN, OppoElo: 3}); !errors.Is(err, ErrProtocol) {
		t.Fatal(err)
	}
	if !w.sched.Idle() {
		t.Fatal("slot leaked")
	}
}

func TestInitializationTimeoutKillsAndReaps(t *testing.T) {
	w, path := persistentWorker(t)
	t.Setenv("MAIA_JSON_SLOW_INIT", "1")
	w.startWait = 150 * time.Millisecond
	done := make(chan error, 1)
	go func() {
		_, release, err := w.Predict(context.Background(), context.Background(), sched.PriorityFocus, 0, MaiaRequest{FEN: startFEN})
		if release != nil {
			release()
		}
		done <- err
	}()
	pid := awaitPID(t, path)
	if err := <-done; !errors.Is(err, ErrProtocol) {
		t.Fatalf("timeout: %v", err)
	}
	if !w.sched.Idle() {
		t.Fatal("initialization slot leaked")
	}
	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("initializing PID %d not reaped: %v", pid, err)
	}
}

func TestInvalidPositionResponseLeavesWarmWorkerReady(t *testing.T) {
	w, _ := persistentWorker(t)
	if _, err := predictSync(t, w, MaiaRequest{FEN: startFEN, OppoElo: 4}); !errors.Is(err, ErrInvalidPosition) {
		t.Fatal(err)
	}
	w.mu.Lock()
	pid := w.proc.cmd.Process.Pid
	w.mu.Unlock()
	result, err := predictSync(t, w, MaiaRequest{FEN: startFEN, OppoElo: 2})
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
	oldWait := SyncWaitFocus
	SyncWaitFocus = 100 * time.Millisecond
	defer func() { SyncWaitFocus = oldWait }()
	w, path := persistentWorker(t)
	request := MaiaRequest{FEN: startFEN, SelfElo: 400, Temperature: .7}
	done := make(chan error, 1)
	go func() {
		_, release, err := w.Predict(context.Background(), context.Background(), sched.PriorityFocus, 0, request)
		if release != nil {
			release()
		}
		done <- err
	}()
	awaitPID(t, path)
	// The same sampled content queues behind the running op (it must never
	// join: a join would report ErrJoined, not busy).
	if _, _, err := w.Predict(context.Background(), context.Background(), sched.PriorityFocus, 0, request); !errors.Is(err, ErrWorkerBusy) {
		t.Fatalf("sampled duplicate joined: %v", err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	// The queued duplicate never ran; a fresh inference still succeeds.
	if _, err := predictSync(t, w, request); err != nil {
		t.Fatal(err)
	}
}
func TestWorkerAcquireReturnsBusyWithoutStartingProcess(t *testing.T) {
	w := NewWorker("test", nil)
	grant, joined, err := w.sched.Acquire(context.Background(), sched.PriorityBatch, "hold", 0)
	if err != nil || joined {
		t.Fatalf("hold: %v %t", err, joined)
	}
	defer w.sched.Release(grant)
	oldWait := SyncWaitFocus
	SyncWaitFocus = 50 * time.Millisecond
	defer func() { SyncWaitFocus = oldWait }()
	if _, _, err := w.Predict(context.Background(), context.Background(), sched.PriorityFocus, 0, MaiaRequest{}); !errors.Is(err, ErrWorkerBusy) {
		t.Fatal(err)
	}
	if w.proc != nil {
		t.Fatal("busy admission started a process")
	}
}

func backdateIdle(t *testing.T, w *Worker, age time.Duration) {
	t.Helper()
	w.idleMu.Lock()
	w.lastActive = time.Now().Add(-age)
	w.idleMu.Unlock()
}

func TestIdleUnloadFreesWarmWorkerAndColdStarts(t *testing.T) {
	w, _ := persistentWorker(t)
	if _, err := predictSync(t, w, MaiaRequest{FEN: startFEN}); err != nil {
		t.Fatal(err)
	}
	w.mu.Lock()
	pid := w.proc.cmd.Process.Pid
	w.mu.Unlock()
	w.SetIdleTimeout(50 * time.Millisecond)
	backdateIdle(t, w, time.Hour)
	if !w.tryUnloadIdle(time.Now()) {
		t.Fatal("idle worker was not unloaded")
	}
	if w.proc != nil || w.WorkerStatus().State != stateUnloaded {
		t.Fatalf("after unload proc=%v state=%s", w.proc, w.WorkerStatus().State)
	}
	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("PID %d not reaped: %v", pid, err)
	}
	// Next inference cold-starts a fresh process.
	result, err := predictSync(t, w, MaiaRequest{FEN: startFEN, OppoElo: 2})
	if err != nil || result.Move != "d2d4" {
		t.Fatalf("cold restart: %+v %v", result, err)
	}
}

func TestIdleUnloadSkipsRecentAndBusy(t *testing.T) {
	w, path := persistentWorker(t)
	w.SetIdleTimeout(time.Hour)
	if _, err := predictSync(t, w, MaiaRequest{FEN: startFEN}); err != nil {
		t.Fatal(err)
	}
	// Recent activity: no eviction even when the sweep runs.
	if w.tryUnloadIdle(time.Now()) {
		t.Fatal("recent worker unloaded")
	}
	// Disabled timeout never evicts, even when long idle.
	w.SetIdleTimeout(0)
	backdateIdle(t, w, 24*time.Hour)
	if w.tryUnloadIdle(time.Now()) {
		t.Fatal("disabled timeout unloaded")
	}
	// Busy worker is never interrupted, even when the last admission is
	// older than the timeout (long inference vs short timeout).
	w.SetIdleTimeout(50 * time.Millisecond)
	_ = os.Remove(path)
	done := make(chan error, 1)
	go func() {
		_, release, err := w.Predict(context.Background(), context.Background(), sched.PriorityFocus, 0,
			MaiaRequest{FEN: startFEN, SelfElo: 400})
		if release != nil {
			release()
		}
		done <- err
	}()
	awaitPID(t, path)
	// The 400ms inference is now running; sleep past the 50ms timeout so
	// the time check passes and only the busy guards can save it.
	time.Sleep(100 * time.Millisecond)
	if w.sched.Idle() {
		t.Fatal("test setup: scheduler idle during running op")
	}
	if w.tryUnloadIdle(time.Now()) {
		t.Fatal("busy worker unloaded")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	// After completion the timer resets: immediate sweep keeps it warm.
	if w.tryUnloadIdle(time.Now()) {
		t.Fatal("just-used worker unloaded")
	}
}

func TestPoolSweepIdleUnloadsBoth(t *testing.T) {
	large, _ := persistentWorker(t)
	small, _ := persistentWorker(t)
	large.SetIdleTimeout(time.Millisecond)
	small.SetIdleTimeout(time.Millisecond)
	if _, err := predictSync(t, large, MaiaRequest{FEN: startFEN}); err != nil {
		t.Fatal(err)
	}
	if _, err := predictSync(t, small, MaiaRequest{FEN: startFEN}); err != nil {
		t.Fatal(err)
	}
	backdateIdle(t, large, time.Hour)
	backdateIdle(t, small, time.Hour)
	pool := NewEnginePool(large, small)
	pool.SweepIdle(time.Now())
	if large.WorkerStatus().State != stateUnloaded || small.WorkerStatus().State != stateUnloaded {
		t.Fatalf("sweep left %s / %s", large.WorkerStatus().State, small.WorkerStatus().State)
	}
	// Fakes without idle support are ignored.
	pool = NewEnginePool(&fakePredictor{}, &fakePredictor{})
	pool.SweepIdle(time.Now())
}
