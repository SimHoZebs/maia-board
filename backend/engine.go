package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	workerAcquireWait = 100 * time.Millisecond
	workerStartWait   = 300 * time.Second
	workerMoveWait    = 120 * time.Second
	maxMultiPV        = 5
)

var (
	ErrWorkerBusy       = errors.New("engine worker is busy")
	ErrProtocol         = errors.New("engine protocol error")
	ErrPositionMismatch = errors.New("position mismatch")
	ErrInvalidPosition  = errors.New("invalid position")
	ErrNoLegalMoves     = errors.New("position has no legal moves")
)

type EngineRequest struct {
	FEN         string
	Moves       []string
	InitialFEN  string
	SelfElo     int
	OppoElo     int
	Temperature float64
}

type Candidate struct {
	Move   string
	Policy float64
	WDL    [3]float64
}

type EngineResult struct {
	Move       string
	Candidates []Candidate
	WDL        [3]float64
}

type workerState string

const (
	stateUnloaded workerState = "unloaded"
	stateStarting workerState = "starting"
	stateReady    workerState = "ready"
	stateBusy     workerState = "busy"
	stateFailed   workerState = "failed"
)

type WorkerStatus struct {
	State     workerState `json:"state"`
	LastError string      `json:"last_error,omitempty"`
}

type workerProcess struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
}

type predictor interface {
	predict(context.Context, EngineRequest) (EngineResult, error)
	snapshot() WorkerStatus
}

type Worker struct {
	name      string
	command   []string
	startWait time.Duration
	moveWait  time.Duration

	slot chan struct{}

	mu      sync.Mutex
	stateMu sync.RWMutex
	proc    *workerProcess
	state   workerState
	last    string
	busy    bool
}

func NewWorker(name string, command []string) *Worker {
	return &Worker{
		name:      name,
		command:   append([]string(nil), command...),
		startWait: workerStartWait,
		moveWait:  workerMoveWait,
		slot:      make(chan struct{}, 1),
		state:     stateUnloaded,
	}
}

func (w *Worker) snapshot() WorkerStatus {
	w.stateMu.RLock()
	defer w.stateMu.RUnlock()
	state := w.state
	if w.busy {
		state = stateBusy
	}
	return WorkerStatus{State: state, LastError: sanitizeError(w.last)}
}

func (w *Worker) acquire(ctx context.Context) error {
	timer := time.NewTimer(workerAcquireWait)
	defer timer.Stop()
	select {
	case w.slot <- struct{}{}:
		w.stateMu.Lock()
		w.busy = true
		w.stateMu.Unlock()
		return nil
	case <-timer.C:
		return ErrWorkerBusy
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (w *Worker) release() {
	w.stateMu.Lock()
	w.busy = false
	w.stateMu.Unlock()
	<-w.slot
}

func (w *Worker) predict(ctx context.Context, request EngineRequest) (EngineResult, error) {
	if err := w.acquire(ctx); err != nil {
		return EngineResult{}, err
	}
	defer w.release()

	w.mu.Lock()
	defer w.mu.Unlock()
	return w.predictLocked(ctx, request)
}

func (w *Worker) predictLocked(ctx context.Context, request EngineRequest) (EngineResult, error) {
	if w.proc == nil {
		w.setState(stateStarting)
		startCtx, cancel := context.WithTimeout(ctx, w.startWait)
		err := w.startLocked(startCtx)
		cancel()
		if err != nil {
			w.handleFailureLocked(err)
			return EngineResult{}, err
		}
	}

	if err := w.sendLocked(ctx, "setoption name SelfElo value "+strconv.Itoa(request.SelfElo)); err != nil {
		w.handleFailureLocked(err)
		return EngineResult{}, err
	}
	if err := w.sendLocked(ctx, "setoption name OppoElo value "+strconv.Itoa(request.OppoElo)); err != nil {
		w.handleFailureLocked(err)
		return EngineResult{}, err
	}
	if err := w.sendLocked(ctx, "setoption name MultiPV value "+strconv.Itoa(maxMultiPV)); err != nil {
		w.handleFailureLocked(err)
		return EngineResult{}, err
	}
	if err := w.sendLocked(ctx, "setoption name Temperature value "+strconv.FormatFloat(request.Temperature, 'f', -1, 64)); err != nil {
		w.handleFailureLocked(err)
		return EngineResult{}, err
	}
	if err := w.sendLocked(ctx, "setoption name ExpectedFEN value "+request.FEN); err != nil {
		w.handleFailureLocked(err)
		return EngineResult{}, err
	}

	if err := w.sendLocked(ctx, positionCommand(request)); err != nil {
		w.handleFailureLocked(err)
		return EngineResult{}, err
	}

	positionCtx, cancel := context.WithTimeout(ctx, w.moveWait)
	marker, err := w.readPositionMarkerLocked(positionCtx)
	cancel()
	if err != nil {
		w.handleFailureLocked(err)
		return EngineResult{}, err
	}
	if marker.mismatch {
		return EngineResult{}, ErrPositionMismatch
	}
	if marker.invalid {
		return EngineResult{}, ErrInvalidPosition
	}
	if marker.legalCount == 0 {
		return EngineResult{}, ErrNoLegalMoves
	}

	if err := w.sendLocked(ctx, "go nodes 1"); err != nil {
		w.handleFailureLocked(err)
		return EngineResult{}, err
	}

	moveCtx, cancel := context.WithTimeout(ctx, w.moveWait)
	result, err := w.readMoveLocked(moveCtx, marker.legalCount)
	cancel()
	if err != nil {
		w.handleFailureLocked(err)
		return EngineResult{}, err
	}
	return result, nil
}

type positionMarker struct {
	legalCount int
	mismatch   bool
	invalid    bool
}

func (w *Worker) startLocked(ctx context.Context) error {
	if len(w.command) == 0 {
		return fmt.Errorf("%w: empty worker command", ErrProtocol)
	}

	cmd := exec.Command(w.command[0], w.command[1:]...)
	cmd.Env = append(os.Environ(), "PYTHONUNBUFFERED=1")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("%w: stdin pipe: %v", ErrProtocol, err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("%w: stdout pipe: %v", ErrProtocol, err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("%w: stderr pipe: %v", ErrProtocol, err)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("%w: start %s: %v", ErrProtocol, w.name, err)
	}
	go func() { _, _ = io.Copy(io.Discard, stderr) }()
	w.proc = &workerProcess{cmd: cmd, stdin: stdin, stdout: bufio.NewReader(stdout)}

	if err := w.sendLocked(ctx, "uci"); err != nil {
		return err
	}
	if err := w.readUntilLocked(ctx, "uciok"); err != nil {
		return err
	}
	if err := w.sendLocked(ctx, "isready"); err != nil {
		return err
	}
	if err := w.readUntilLocked(ctx, "readyok"); err != nil {
		return err
	}
	w.setState(stateReady)
	w.setLast("")
	return nil
}

func (w *Worker) sendLocked(ctx context.Context, line string) error {
	if w.proc == nil {
		return fmt.Errorf("%w: %s is not running", ErrProtocol, w.name)
	}
	proc := w.proc
	result := make(chan error, 1)
	go func() {
		_, err := io.WriteString(proc.stdin, line+"\n")
		result <- err
	}()
	select {
	case err := <-result:
		if err != nil {
			return fmt.Errorf("%w: write %s: %v", ErrProtocol, w.name, err)
		}
	case <-ctx.Done():
		return fmt.Errorf("%w: write %s canceled: %w", ErrProtocol, w.name, ctx.Err())
	}
	return nil
}

type readLineResult struct {
	line string
	err  error
}

func (w *Worker) readLineLocked(ctx context.Context) (string, error) {
	if w.proc == nil {
		return "", fmt.Errorf("%w: process disappeared", ErrProtocol)
	}
	proc := w.proc
	result := make(chan readLineResult, 1)
	go func() {
		line, err := proc.stdout.ReadString('\n')
		result <- readLineResult{line: strings.TrimSpace(line), err: err}
	}()
	select {
	case value := <-result:
		if value.err != nil {
			return value.line, fmt.Errorf("%w: read %s: %v", ErrProtocol, w.name, value.err)
		}
		return value.line, nil
	case <-ctx.Done():
		return "", fmt.Errorf("%w: %s timeout: %w", ErrProtocol, w.name, ctx.Err())
	}
}

func (w *Worker) readUntilLocked(ctx context.Context, target string) error {
	for {
		line, err := w.readLineLocked(ctx)
		if err != nil {
			return err
		}
		if line == target {
			return nil
		}
	}
}

func (w *Worker) readPositionMarkerLocked(ctx context.Context) (positionMarker, error) {
	for {
		line, err := w.readLineLocked(ctx)
		if err != nil {
			return positionMarker{}, err
		}
		if line == "info string position-error position-mismatch" {
			return positionMarker{mismatch: true}, nil
		}
		if line == "info string position-error invalid-position" {
			return positionMarker{invalid: true}, nil
		}
		if strings.HasPrefix(line, "info string position-ok legal-count ") {
			count, err := strconv.Atoi(strings.TrimPrefix(line, "info string position-ok legal-count "))
			if err != nil || count < 0 {
				return positionMarker{}, fmt.Errorf("%w: invalid legal-count marker", ErrProtocol)
			}
			return positionMarker{legalCount: count}, nil
		}
	}
}

func (w *Worker) readMoveLocked(ctx context.Context, legalCount int) (EngineResult, error) {
	lines := make([]string, 0, maxMultiPV+1)
	for {
		line, err := w.readLineLocked(ctx)
		if err != nil {
			return EngineResult{}, err
		}
		if strings.HasPrefix(line, "info ") {
			if strings.HasPrefix(line, "info string go-error") || strings.HasPrefix(line, "info string adapter-error") {
				return EngineResult{}, fmt.Errorf("%w: %s", ErrProtocol, line)
			}
			lines = append(lines, line)
			continue
		}
		if strings.HasPrefix(line, "bestmove ") {
			lines = append(lines, line)
			return parseEngineTranscript(lines, legalCount)
		}
	}
}

func (w *Worker) failLocked(err error) {
	w.setLast(err.Error())
	w.setState(stateFailed)
	w.stopProcessLocked()
}

func (w *Worker) handleFailureLocked(err error) {
	if errors.Is(err, context.Canceled) {
		w.setLast("request canceled")
		w.setState(stateUnloaded)
		w.stopProcessLocked()
		return
	}
	w.failLocked(err)
}

func (w *Worker) setState(state workerState) {
	w.stateMu.Lock()
	w.state = state
	w.stateMu.Unlock()
}

func (w *Worker) setLast(last string) {
	w.stateMu.Lock()
	w.last = sanitizeError(last)
	w.stateMu.Unlock()
}

func (w *Worker) stopProcessLocked() {
	if w.proc == nil {
		return
	}
	proc := w.proc
	w.proc = nil
	_ = proc.stdin.Close()
	if proc.cmd.Process != nil {
		_ = proc.cmd.Process.Kill()
	}
	_ = proc.cmd.Wait()
}

func (w *Worker) close() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.proc == nil {
		return
	}
	proc := w.proc
	w.proc = nil
	_ = proc.stdin.Close()
	if proc.cmd.Process != nil {
		_ = proc.cmd.Process.Kill()
	}
	_ = proc.cmd.Wait()
	w.setState(stateUnloaded)
}

func positionCommand(request EngineRequest) string {
	if len(request.Moves) == 0 {
		if request.InitialFEN != "" {
			return "position fen " + request.InitialFEN
		}
		return "position fen " + request.FEN
	}
	if request.InitialFEN == "" {
		return "position startpos moves " + strings.Join(request.Moves, " ")
	}
	return "position fen " + request.InitialFEN + " moves " + strings.Join(request.Moves, " ")
}

type parsedInfo struct {
	rank   int
	move   string
	policy float64
	wdl    [3]float64
}

func parseInfoLine(line string) (parsedInfo, error) {
	fields := strings.Fields(line)
	if len(fields) < 2 || fields[0] != "info" {
		return parsedInfo{}, fmt.Errorf("%w: expected info line", ErrProtocol)
	}
	result := parsedInfo{}
	seen := map[string]bool{}
	for i := 1; i < len(fields); i++ {
		switch fields[i] {
		case "multipv":
			if seen["multipv"] || i+1 >= len(fields) {
				return parsedInfo{}, fmt.Errorf("%w: invalid multipv", ErrProtocol)
			}
			value, err := strconv.Atoi(fields[i+1])
			if err != nil {
				return parsedInfo{}, fmt.Errorf("%w: invalid multipv", ErrProtocol)
			}
			result.rank = value
			seen["multipv"] = true
			i++
		case "wdl":
			if seen["wdl"] || i+3 >= len(fields) {
				return parsedInfo{}, fmt.Errorf("%w: invalid wdl", ErrProtocol)
			}
			win, err1 := strconv.Atoi(fields[i+1])
			draw, err2 := strconv.Atoi(fields[i+2])
			loss, err3 := strconv.Atoi(fields[i+3])
			if err1 != nil || err2 != nil || err3 != nil || !validPermille(win) || !validPermille(draw) || !validPermille(loss) {
				return parsedInfo{}, fmt.Errorf("%w: invalid wdl values", ErrProtocol)
			}
			result.wdl = [3]float64{float64(loss) / 1000, float64(draw) / 1000, float64(win) / 1000}
			seen["wdl"] = true
			i += 3
		case "pv":
			if seen["pv"] || i+1 >= len(fields) {
				return parsedInfo{}, fmt.Errorf("%w: invalid pv", ErrProtocol)
			}
			result.move = fields[i+1]
			seen["pv"] = true
			i++
		case "string":
			if i+2 >= len(fields) || fields[i+1] != "policy" || seen["policy"] {
				return parsedInfo{}, fmt.Errorf("%w: missing policy", ErrProtocol)
			}
			policy, err := strconv.ParseFloat(fields[i+2], 64)
			if err != nil || math.IsNaN(policy) || math.IsInf(policy, 0) || policy < 0 || policy > 1 {
				return parsedInfo{}, fmt.Errorf("%w: invalid policy", ErrProtocol)
			}
			result.policy = policy
			seen["policy"] = true
			i += 2
		}
	}
	if !seen["multipv"] || !seen["wdl"] || !seen["pv"] || !seen["policy"] || result.rank < 1 || result.move == "" {
		return parsedInfo{}, fmt.Errorf("%w: incomplete candidate line", ErrProtocol)
	}
	return result, nil
}

func parseEngineTranscript(lines []string, legalCount int) (EngineResult, error) {
	if legalCount < 1 {
		return EngineResult{}, fmt.Errorf("%w: missing legal count", ErrProtocol)
	}
	bestmove := ""
	byRank := map[int]parsedInfo{}
	for _, line := range lines {
		if strings.HasPrefix(line, "info ") {
			candidate, err := parseInfoLine(line)
			if err != nil {
				return EngineResult{}, err
			}
			if candidate.rank > maxMultiPV || byRank[candidate.rank].move != "" {
				return EngineResult{}, fmt.Errorf("%w: duplicate or out-of-range multipv rank", ErrProtocol)
			}
			byRank[candidate.rank] = candidate
			continue
		}
		if strings.HasPrefix(line, "bestmove ") {
			fields := strings.Fields(line)
			if len(fields) != 2 || fields[1] == "0000" {
				return EngineResult{}, fmt.Errorf("%w: no legal bestmove", ErrProtocol)
			}
			bestmove = fields[1]
		}
	}
	want := legalCount
	if want > maxMultiPV {
		want = maxMultiPV
	}
	if len(byRank) != want || bestmove == "" {
		return EngineResult{}, fmt.Errorf("%w: expected %d candidates, got %d", ErrProtocol, want, len(byRank))
	}
	result := EngineResult{Move: bestmove}
	for rank := 1; rank <= want; rank++ {
		candidate, ok := byRank[rank]
		if !ok {
			return EngineResult{}, fmt.Errorf("%w: missing multipv rank %d", ErrProtocol, rank)
		}
		result.Candidates = append(result.Candidates, Candidate{Move: candidate.move, Policy: candidate.policy, WDL: candidate.wdl})
	}
	// Sampling may choose a move outside the reported top candidates. WDL
	// describes the highest-policy candidate, independent of sampling temperature.
	result.WDL = result.Candidates[0].WDL
	return result, nil
}

func validPermille(value int) bool { return value >= 0 && value <= 1000 }

func sanitizeError(value string) string {
	value = strings.Join(strings.Fields(value), " ")
	if len(value) > 160 {
		return value[:160]
	}
	return value
}

type EnginePool struct {
	large predictor
	small predictor
}

func NewEnginePool(large, small predictor) *EnginePool {
	return &EnginePool{large: large, small: small}
}

func (p *EnginePool) predict(ctx context.Context, model string, request EngineRequest) (EngineResult, string, bool, error) {
	if model == "5m" {
		result, err := p.small.predict(ctx, request)
		return result, "5m", false, err
	}

	result, err := p.large.predict(ctx, request)
	if err == nil {
		return result, "79m", false, nil
	}
	if errors.Is(err, ErrWorkerBusy) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, ErrPositionMismatch) || errors.Is(err, ErrInvalidPosition) || errors.Is(err, ErrNoLegalMoves) {
		return EngineResult{}, "", false, err
	}
	result, fallbackErr := p.small.predict(ctx, request)
	if fallbackErr != nil {
		return EngineResult{}, "", false, fmt.Errorf("engine fallback failed: %w", errors.Join(err, fallbackErr))
	}
	return result, "5m", true, nil
}

func (p *EnginePool) health() (string, map[string]WorkerStatus, int) {
	large := p.large.snapshot()
	small := p.small.snapshot()
	status := "ok"
	code := 200
	if large.State == stateFailed && small.State == stateFailed {
		status = "unavailable"
		code = 503
	} else if large.State == stateFailed || small.State == stateFailed {
		status = "degraded"
	}
	return status, map[string]WorkerStatus{"79m": large, "5m": small}, code
}
