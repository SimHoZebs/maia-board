package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

const startFEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

func TestEvaluationOutputLimit(t *testing.T) {
	var output cappedOutput
	_, err := io.Copy(&output, io.LimitReader(strings.NewReader(strings.Repeat("x", 65537)), 65537))
	if err == nil || len(output.Bytes()) > 65536 {
		t.Fatal("output collection exceeded bound")
	}
}

// Re-exec the Go test binary as an isolated helper; no Python needed for HTTP tests.
func TestEvaluationHelper(t *testing.T) {
	mode := os.Getenv("SF_TEST_HELPER")
	if mode == "" {
		return
	}
	switch mode {
	case "hang", "crash":
		child := exec.Command(os.Args[0], "-test.run=TestEvaluationHelper")
		child.Env = append(os.Environ(), "SF_TEST_HELPER=child")
		if err := child.Start(); err != nil {
			os.Exit(2)
		}
		_ = os.WriteFile(os.Getenv("SF_TEST_PID"), []byte(fmt.Sprintf("%d %d", os.Getpid(), child.Process.Pid)), 0600)
		if mode == "crash" {
			os.Exit(2)
		}
		_ = child.Wait()
	case "child":
		time.Sleep(time.Minute)
	case "bad":
		fmt.Print("not json /secret/path")
	case "settings":
		var request evaluationRequest
		if err := json.NewDecoder(os.Stdin).Decode(&request); err != nil {
			os.Exit(2)
		}
		terminal := "draw"
		_ = json.NewEncoder(os.Stdout).Encode(evaluationResponse{Engine: "Stockfish 19", SearchPolicy: request.Settings.policy(), Terminal: &terminal, Score: evaluationScore{Type: "cp"}, Lines: []evaluationLine{}})
	case "white_win", "black_win":
		_ = json.NewEncoder(os.Stdout).Encode(evaluationResponse{Engine: "Stockfish 19", SearchPolicy: SearchPolicy, Terminal: &mode, Score: evaluationScore{Type: "mate", WinningSide: strings.TrimSuffix(mode, "_win")}, Lines: []evaluationLine{}})
	case "position_mismatch", "invalid_position", "invalid_fen", "engine_unavailable":
		_ = json.NewEncoder(os.Stdout).Encode(apiError{mode, "/secret/path"})
	case "duplicates", "wrongbest":
		best := "g8f6"
		if mode == "wrongbest" {
			best = "f8c5"
		}
		fmt.Fprintf(os.Stdout, `{"engine":"Stockfish 19","search_policy":"sf19-n100k-ms750-mpv2-t1-h64-v1","depth":12,"terminal":null,"best_move":"%s","score":{"type":"cp","value":-92},"lines":[{"move":"g8f6","score":{"type":"cp","value":-92},"depth":12},{"move":"g8f6","score":{"type":"cp","value":-92},"depth":12}]}`, best)
	case "slow":
		time.Sleep(300 * time.Millisecond)
		fmt.Print(`{"engine":"Stockfish 19","search_policy":"sf19-n100k-ms750-mpv2-t1-h64-v1","depth":0,"terminal":"draw","best_move":null,"score":{"type":"cp","value":0},"lines":[]}`)
	default:
		fmt.Print(`{"engine":"Stockfish 19","search_policy":"sf19-n100k-ms750-mpv2-t1-h64-v1","depth":0,"terminal":"draw","best_move":null,"score":{"type":"cp","value":0},"lines":[]}`)
	}
	os.Exit(0)
}

func fakeEvaluator(t *testing.T, mode string) *Evaluator {
	t.Helper()
	t.Setenv("SF_TEST_HELPER", mode)
	return &Evaluator{command: []string{os.Args[0], "-test.run=TestEvaluationHelper"}, sched: NewScheduler(), timeout: time.Second}
}

func TestEvaluateHTTP(t *testing.T) {
	valid := `{"fen":"` + startFEN + `","moves":[]}`
	for _, tc := range []struct {
		name, body, mode, code string
		status                 int
	}{
		{"success", valid, "ok", "", 200},
		{"white terminal", valid, "white_win", "", 200},
		{"black terminal", valid, "black_win", "", 200},
		{"configured", `{"fen":"` + startFEN + `","settings":{"time_ms":2000,"lines":5,"depth":18}}`, "settings", "", 200},
		{"invalid settings", `{"fen":"` + startFEN + `","settings":{"time_ms":30001,"lines":5,"depth":18}}`, "settings", "invalid_request", 400},
		{"wrong policy", `{"fen":"` + startFEN + `","settings":{"time_ms":2000,"lines":5,"depth":18}}`, "ok", "engine_unavailable", 502},
		{"malformed", "{", "ok", "invalid_json", 400},
		{"unknown", `{"fen":"` + startFEN + `","flags":[]}`, "ok", "invalid_json", 400},
		{"trailing", valid + ` {}`, "ok", "invalid_json", 400},
		{"size", `{"fen":"` + strings.Repeat("x", 65536) + `"}`, "ok", "invalid_json", 400},
		{"fen", `{"fen":"no"}`, "ok", "invalid_fen", 400},
		{"uci", `{"fen":"` + startFEN + `","moves":["e2e9"]}`, "ok", "invalid_position", 400},
		{"mismatch", valid, "position_mismatch", "position_mismatch", 400},
		{"semantic", valid, "invalid_position", "invalid_position", 400},
		{"unavailable", valid, "engine_unavailable", "engine_unavailable", 502},
		{"bad helper", valid, "bad", "engine_unavailable", 502},
		{"duplicate lines", valid, "duplicates", "engine_unavailable", 502},
		{"wrong best move", valid, "wrongbest", "engine_unavailable", 502},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &server{evaluator: fakeEvaluator(t, tc.mode)}
			w := httptest.NewRecorder()
			s.evaluate(w, httptest.NewRequest("POST", "/evaluate", strings.NewReader(tc.body)))
			if w.Code != tc.status {
				t.Fatalf("status %d: %s", w.Code, w.Body)
			}
			if tc.code != "" && !strings.Contains(w.Body.String(), `"code":"`+tc.code+`"`) {
				t.Fatal(w.Body)
			}
			if strings.Contains(w.Body.String(), "/secret") {
				t.Fatal("leaked helper details")
			}
		})
	}
	e := fakeEvaluator(t, "ok")
	hold, joined, err := e.sched.Acquire(context.Background(), PriorityBatch, "hold", 0)
	if err != nil || joined {
		t.Fatalf("hold: %v %t", err, joined)
	}
	defer e.sched.Release(hold)
	oldWait := syncWaitFocus
	syncWaitFocus = 50 * time.Millisecond
	defer func() { syncWaitFocus = oldWait }()
	w := httptest.NewRecorder()
	(&server{evaluator: e}).evaluate(w, httptest.NewRequest("POST", "/evaluate", strings.NewReader(valid)))
	if w.Code != 503 || w.Header().Get("Retry-After") != "1" {
		t.Fatal(w)
	}
	w = httptest.NewRecorder()
	(&server{}).evaluate(w, httptest.NewRequest("GET", "/evaluate", nil))
	if w.Code != 405 {
		t.Fatal(w.Code)
	}
	r := evaluationRequest{FEN: startFEN, Moves: make([]string, 257)}
	if err := validateEvaluationRequest(&r); err == nil || err.Code != "history_too_long" {
		t.Fatal(err)
	}
}

func TestEvaluateCacheReadThrough(t *testing.T) {
	cached := `{"fen":"` + startFEN + `","moves":[],"cache_hash":"abc123","cache_key":"test-key"}`
	store := testStore(t)
	// Miss: computes live, stores the row, reports miss.
	s := &server{evaluator: fakeEvaluator(t, "ok"), store: store}
	w := httptest.NewRecorder()
	s.evaluate(w, httptest.NewRequest("POST", "/evaluate", strings.NewReader(cached)))
	if w.Code != 200 || w.Header().Get("X-Eval-Cache") != "miss" {
		t.Fatalf("miss: %d %s header=%q", w.Code, w.Body, w.Header().Get("X-Eval-Cache"))
	}
	first := w.Body.String()
	// Hit: serves from SQLite without an evaluator configured.
	hit := &server{store: store}
	w = httptest.NewRecorder()
	hit.evaluate(w, httptest.NewRequest("POST", "/evaluate", strings.NewReader(cached)))
	if w.Code != 200 || w.Header().Get("X-Eval-Cache") != "hit" {
		t.Fatalf("hit: %d %s header=%q", w.Code, w.Body, w.Header().Get("X-Eval-Cache"))
	}
	if normalizeJSON(t, w.Body.String()) != normalizeJSON(t, first) {
		t.Fatalf("cached body changed:\n%s\n%s", first, w.Body)
	}
	// Client-provided coordinates cannot alter the server-derived identity.
	stale := `{"fen":"` + startFEN + `","moves":[],"cache_hash":"abc123","cache_key":"other-key"}`
	w = httptest.NewRecorder()
	s.evaluate(w, httptest.NewRequest("POST", "/evaluate", strings.NewReader(stale)))
	if w.Code != 200 || w.Header().Get("X-Eval-Cache") != "hit" {
		t.Fatalf("ignored coordinates: %d %s header=%q", w.Code, w.Body, w.Header().Get("X-Eval-Cache"))
	}
	w = httptest.NewRecorder()
	hit.evaluate(w, httptest.NewRequest("POST", "/evaluate", strings.NewReader(stale)))
	if w.Code != 200 || w.Header().Get("X-Eval-Cache") != "hit" {
		t.Fatalf("stale overwrite: %d %s header=%q", w.Code, w.Body, w.Header().Get("X-Eval-Cache"))
	}
	// Corrupt row: validation fails, falls through to live inference.
	hash, key := sfIdentity(evaluationRequest{FEN: startFEN}).coordinates()
	if _, err := store.cachePut(hash, "sf", key, `{"a":1}`); err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	s.evaluate(w, httptest.NewRequest("POST", "/evaluate", strings.NewReader(`{"fen":"`+startFEN+`","moves":[],"cache_hash":"deadbeef","cache_key":"k"}`)))
	if w.Code != 200 || w.Header().Get("X-Eval-Cache") != "miss" {
		t.Fatalf("corrupt: %d %s header=%q", w.Code, w.Body, w.Header().Get("X-Eval-Cache"))
	}
	// No client coordinates still uses the canonical server cache.
	w = httptest.NewRecorder()
	s.evaluate(w, httptest.NewRequest("POST", "/evaluate", strings.NewReader(`{"fen":"`+startFEN+`","moves":[]}`)))
	if w.Code != 200 || w.Header().Get("X-Eval-Cache") != "hit" {
		t.Fatalf("uncached: %d %s header=%q", w.Code, w.Body, w.Header().Get("X-Eval-Cache"))
	}
}

func TestEvaluationCancellationKillsGroup(t *testing.T) {
	for _, mode := range []string{"cancel", "timeout", "crash"} {
		t.Run(mode, func(t *testing.T) {
			e := fakeEvaluator(t, "hang")
			if mode == "crash" {
				t.Setenv("SF_TEST_HELPER", "crash")
			}
			e.timeout = 3 * time.Second
			if mode == "timeout" {
				e.timeout = 200 * time.Millisecond
			}
			path := filepath.Join(t.TempDir(), "pids")
			t.Setenv("SF_TEST_PID", path)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() { _, _, err := e.run(ctx, ctx, PriorityFocus, 0, evaluationRequest{FEN: startFEN}); done <- err }()
			var pids []byte
			deadline := time.Now().Add(2 * time.Second)
			for time.Now().Before(deadline) {
				pids, _ = os.ReadFile(path)
				if len(pids) > 0 {
					break
				}
				time.Sleep(5 * time.Millisecond)
			}
			if len(pids) == 0 {
				t.Fatal("helper failed to start")
			}
			if mode == "cancel" {
				cancel()
			}
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("expected process failure")
				}
			case <-time.After(3 * time.Second):
				t.Fatal("cancellation stalled")
			}
			for _, p := range strings.Fields(string(pids)) {
				pid, _ := strconv.Atoi(p)
				// A killed orphan may await PID 1 reaping; zombies cannot execute.
				data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
				if err == nil && !strings.Contains(string(data), ") Z ") {
					_ = syscall.Kill(pid, syscall.SIGKILL)
					t.Fatalf("process still executing: %s", data)
				}
				if os.Getpid() == 1 && err == nil {
					t.Fatalf("PID 1 failed to reap process %d", pid)
				}
			}
			if !e.sched.Idle() {
				t.Fatal("admission slot leaked")
			}
		})
	}
}

func TestRealStockfishHTTPAndCancellation(t *testing.T) {
	binary := os.Getenv("STOCKFISH_BINARY")
	if binary == "" {
		t.Skip("set STOCKFISH_BINARY and STOCKFISH_WORKER for integration test")
	}
	helper := getenv("STOCKFISH_WORKER", "stockfish_worker.py")
	e := NewEvaluator(getenv("PYTHON", "python3"), helper, binary)
	w := httptest.NewRecorder()
	(&server{evaluator: e}).evaluate(w, httptest.NewRequest("POST", "/evaluate", strings.NewReader(`{"fen":"`+startFEN+`","moves":[]}`)))
	if w.Code != 200 {
		t.Fatalf("real evaluation: %d %s", w.Code, w.Body)
	}
	w = httptest.NewRecorder()
	(&server{evaluator: e}).evaluate(w, httptest.NewRequest("POST", "/evaluate", strings.NewReader(`{"fen":"`+startFEN+`","moves":[],"settings":{"time_ms":2000,"lines":5,"depth":8}}`)))
	var configured evaluationResponse
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &configured) != nil || configured.SearchPolicy != "sf19-ms2000-mpv5-d8-t1-h64-v2" || len(configured.Lines) != 5 || configured.Depth > 8 {
		t.Fatalf("configured real evaluation: %d %s", w.Code, w.Body)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, _, err := e.run(ctx, ctx, PriorityFocus, 0, evaluationRequest{FEN: startFEN}); done <- err }()
	// Observe the real native engine in the wrapper's inherited group before canceling.
	var group, enginePID int
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && enginePID == 0 {
		entries, _ := os.ReadDir("/proc")
		for _, entry := range entries {
			pid, err := strconv.Atoi(entry.Name())
			if err != nil {
				continue
			}
			data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
			if err != nil {
				continue
			}
			end := strings.LastIndex(string(data), ") ")
			if end < 0 {
				continue
			}
			fields := strings.Fields(string(data)[end+2:])
			if len(fields) < 3 {
				continue
			}
			ppid, _ := strconv.Atoi(fields[1])
			pgid, _ := strconv.Atoi(fields[2])
			if ppid == os.Getpid() && pgid == pid {
				group = pid
			}
			if group > 0 && pgid == group && pid != group {
				enginePID = pid
			}
		}
		if enginePID == 0 {
			time.Sleep(2 * time.Millisecond)
		}
	}
	if enginePID == 0 {
		t.Fatal("did not observe native engine in wrapper process group")
	}
	started := time.Now()
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected cancellation")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("real engine cancellation stalled")
	}
	for _, pid := range []int{group, enginePID} {
		data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
		if err == nil && !strings.Contains(string(data), ") Z ") {
			t.Fatalf("live process after cancellation: %s", data)
		}
		if os.Getpid() == 1 && err == nil {
			t.Fatalf("PID 1 failed to reap process %d", pid)
		}
	}
	t.Logf("real wrapper=%d engine=%d canceled and cleaned in %s", group, enginePID, time.Since(started))
}
