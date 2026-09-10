package main

import (
	"context"
	"errors"
	"testing"
)

func TestParseEngineTranscriptMapsWDLAndRanks(t *testing.T) {
	result, err := parseEngineTranscript([]string{
		"info depth 1 multipv 2 score cp 10 wdl 300 200 500 pv d2d4 string policy 0.25",
		"info depth 1 multipv 1 score cp 20 wdl 600 200 200 pv e2e4 string policy 0.50",
		"bestmove e2e4",
	}, 2)
	if err != nil {
		t.Fatal(err)
	}
	if result.Move != "e2e4" || len(result.Candidates) != 2 {
		t.Fatalf("unexpected result: %+v", result)
	}
	if result.Candidates[0].Move != "e2e4" || result.Candidates[0].WDL != [3]float64{0.2, 0.2, 0.6} {
		t.Fatalf("unexpected primary candidate: %+v", result.Candidates[0])
	}
}

func TestParseEngineTranscriptRejectsMissingPolicy(t *testing.T) {
	_, err := parseEngineTranscript([]string{
		"info depth 1 multipv 1 score cp 20 wdl 600 200 200 pv e2e4",
		"bestmove e2e4",
	}, 20)
	if !errors.Is(err, ErrProtocol) {
		t.Fatalf("expected protocol error, got %v", err)
	}
}

func TestParseEngineTranscriptRequiresContiguousRanks(t *testing.T) {
	_, err := parseEngineTranscript([]string{
		"info depth 1 multipv 1 score cp 20 wdl 600 200 200 pv e2e4 string policy 0.5",
		"info depth 1 multipv 3 score cp 10 wdl 300 200 500 pv d2d4 string policy 0.25",
		"bestmove e2e4",
	}, 20)
	if !errors.Is(err, ErrProtocol) {
		t.Fatalf("expected protocol error, got %v", err)
	}
}

func TestParseEngineTranscriptAcceptsOneLegalMove(t *testing.T) {
	result, err := parseEngineTranscript([]string{
		"info depth 1 multipv 1 score cp 20 wdl 600 200 200 pv e2e4 string policy 1.0",
		"bestmove e2e4",
	}, 1)
	if err != nil || len(result.Candidates) != 1 {
		t.Fatalf("unexpected one-move result: %+v, err=%v", result, err)
	}
}

func TestParseEngineTranscriptAcceptsFiveCandidatesWhenManyMovesAreLegal(t *testing.T) {
	lines := []string{
		"info depth 1 multipv 1 score cp 20 wdl 600 200 200 pv e2e4 string policy 0.40",
		"info depth 1 multipv 2 score cp 10 wdl 300 200 500 pv d2d4 string policy 0.25",
		"info depth 1 multipv 3 score cp 5 wdl 300 300 400 pv g1f3 string policy 0.15",
		"info depth 1 multipv 4 score cp 0 wdl 300 300 400 pv c2c4 string policy 0.10",
		"info depth 1 multipv 5 score cp -5 wdl 200 300 500 pv b1c3 string policy 0.05",
		"bestmove e2e4",
	}
	result, err := parseEngineTranscript(lines, 20)
	if err != nil || len(result.Candidates) != 5 {
		t.Fatalf("unexpected five-move result: %+v, err=%v", result, err)
	}
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
	small := &fakePredictor{result: EngineResult{Move: "e2e4"}}
	result, used, degraded, err := NewEnginePool(large, small).predict(context.Background(), "79m", EngineRequest{})
	if err != nil || used != "5m" || !degraded || result.Move != "e2e4" {
		t.Fatalf("unexpected fallback: result=%+v used=%s degraded=%v err=%v", result, used, degraded, err)
	}
	if large.calls != 1 || small.calls != 1 {
		t.Fatalf("unexpected calls: large=%d small=%d", large.calls, small.calls)
	}
}

func TestEnginePoolDoesNotFallbackWhenLargeWorkerBusy(t *testing.T) {
	large := &fakePredictor{err: ErrWorkerBusy}
	small := &fakePredictor{}
	_, used, degraded, err := NewEnginePool(large, small).predict(context.Background(), "79m", EngineRequest{})
	if !errors.Is(err, ErrWorkerBusy) || used != "" || degraded || small.calls != 0 {
		t.Fatalf("unexpected busy behavior: used=%s degraded=%v err=%v small-calls=%d", used, degraded, err, small.calls)
	}
}

func TestEnginePoolDoesNotFallbackAfterClientDeadline(t *testing.T) {
	large := &fakePredictor{err: context.DeadlineExceeded}
	small := &fakePredictor{}
	_, used, degraded, err := NewEnginePool(large, small).predict(context.Background(), "79m", EngineRequest{})
	if !errors.Is(err, context.DeadlineExceeded) || used != "" || degraded || small.calls != 0 {
		t.Fatalf("unexpected deadline behavior: used=%s degraded=%v err=%v small-calls=%d", used, degraded, err, small.calls)
	}
}

func TestWorkerAcquireReturnsBusyWithoutStartingProcess(t *testing.T) {
	worker := NewWorker("test", nil)
	worker.slot <- struct{}{}
	defer func() { <-worker.slot }()
	if _, err := worker.predict(context.Background(), EngineRequest{}); !errors.Is(err, ErrWorkerBusy) {
		t.Fatalf("expected busy error, got %v", err)
	}
}
