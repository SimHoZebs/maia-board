package engine

import (
	"bufio"
	"context"
	"strings"
	"testing"

	"maia-board/backend/internal/ipc"
)

func TestEvaluationOutputLimit(t *testing.T) {
	helper := func(body string) *stockfishWorker {
		return &stockfishWorker{proc: &stockfishProcess{stdout: bufio.NewReader(strings.NewReader(body))}}
	}
	// Over-long reply without a newline: bounded, never unbounded growth.
	if _, err := helper(strings.Repeat("x", ipc.LineLimit+1)).readLineLocked(context.Background()); err == nil {
		t.Fatal("output collection exceeded bound")
	}
	line, err := helper("{\"ok\":true}\n").readLineLocked(context.Background())
	if err != nil || string(line) != "{\"ok\":true}\n" {
		t.Fatalf("bounded line rejected: %v %q", err, line)
	}
}
