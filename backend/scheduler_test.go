package main

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type acquireResult struct {
	grant  *Grant
	joined bool
	err    error
}

// enqueueAsync starts an Acquire that is expected to block until the slot
// frees. Callers must Release the resulting grant (unless err != nil).
func enqueueAsync(s *Scheduler, prio Priority, key, batch string) <-chan acquireResult {
	out := make(chan acquireResult, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		grant, joined, err := s.Acquire(ctx, prio, key, batch)
		out <- acquireResult{grant: grant, joined: joined, err: err}
	}()
	return out
}

func awaitGrant(t *testing.T, ch <-chan acquireResult) *Grant {
	t.Helper()
	select {
	case res := <-ch:
		if res.err != nil {
			t.Fatalf("acquire failed: %v", res.err)
		}
		if res.joined {
			t.Fatal("acquire unexpectedly joined")
		}
		return res.grant
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for grant")
		return nil
	}
}

// Play jumps ahead of queued batch work; FIFO holds within a lane.
func TestSchedulerPlayJumpsBatch(t *testing.T) {
	s := NewScheduler()
	running := awaitGrant(t, enqueueAsync(s, PriorityBatch, "b0", "job1"))

	var mu sync.Mutex
	order := []string{}
	finish := func(key string, ch <-chan acquireResult, wg *sync.WaitGroup) {
		defer wg.Done()
		g := awaitGrant(t, ch)
		mu.Lock()
		order = append(order, key)
		mu.Unlock()
		s.Release(g)
	}
	var wg sync.WaitGroup
	wg.Add(2)
	b1 := enqueueAsync(s, PriorityBatch, "b1", "job1")
	time.Sleep(100 * time.Millisecond)
	p1 := enqueueAsync(s, PriorityPlay, "p1", "")
	time.Sleep(100 * time.Millisecond)
	go finish("b1", b1, &wg)
	go finish("p1", p1, &wg)
	s.Release(running)
	wg.Wait()
	mu.Lock()
	defer mu.Unlock()
	if len(order) != 2 || order[0] != "p1" || order[1] != "b1" {
		t.Fatalf("play must preempt batch, order=%v", order)
	}
}

// Sync focus is single-flight: a newer focus cancels queued stale focus and
// the cancelled waiter never consumes the slot.
func TestSchedulerFocusCoalesces(t *testing.T) {
	s := NewScheduler()
	running := awaitGrant(t, enqueueAsync(s, PriorityBatch, "b0", "job1"))

	focusA := enqueueAsync(s, PriorityFocus, "fA", "")
	time.Sleep(100 * time.Millisecond)
	focusB := enqueueAsync(s, PriorityFocus, "fB", "")
	select {
	case res := <-focusA:
		if !errors.Is(res.err, ErrSuperseded) {
			t.Fatalf("stale focus must be cancelled, got %v", res.err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("stale focus waiter never returned")
	}
	s.Release(running)
	s.Release(awaitGrant(t, focusB))
}

// Queue-full play returns ErrSchedulerBusy instead of growing unbounded.
func TestSchedulerPlayLaneFull(t *testing.T) {
	s := NewScheduler()
	s.maxPlay = 1
	running := awaitGrant(t, enqueueAsync(s, PriorityPlay, "p0", ""))
	queued := enqueueAsync(s, PriorityPlay, "p1", "")
	time.Sleep(100 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, _, err := s.Acquire(ctx, PriorityPlay, "p2", ""); !errors.Is(err, ErrSchedulerBusy) {
		t.Fatalf("expected ErrSchedulerBusy, got %v", err)
	}
	s.Release(running)
	s.Release(awaitGrant(t, queued))
}

// Deterministic duplicates join the running ticket instead of inferring twice.
func TestSchedulerDedupJoin(t *testing.T) {
	s := NewScheduler()
	running := awaitGrant(t, enqueueAsync(s, PriorityBatch, "dup", "job1"))
	joiner := enqueueAsync(s, PriorityBatch, "dup", "job1")
	time.Sleep(100 * time.Millisecond)
	s.Release(running)
	select {
	case res := <-joiner:
		if res.err != nil || !res.joined {
			t.Fatalf("duplicate key must join, err=%v joined=%v", res.err, res.joined)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("joiner never returned")
	}
}

// Abort-while-queued dequeues: a timed-out waiter leaves no residue and the
// next waiter is granted.
func TestSchedulerAbortDequeues(t *testing.T) {
	s := NewScheduler()
	running := awaitGrant(t, enqueueAsync(s, PriorityBatch, "b0", "job1"))
	short, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, _, err := s.Acquire(short, PriorityBatch, "b1", "job1"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline, got %v", err)
	}
	next := enqueueAsync(s, PriorityBatch, "b2", "job1")
	time.Sleep(100 * time.Millisecond)
	s.Release(running)
	s.Release(awaitGrant(t, next))
}

// CancelBatch drops queued batch work; the running op still completes.
func TestSchedulerCancelBatch(t *testing.T) {
	s := NewScheduler()
	running := awaitGrant(t, enqueueAsync(s, PriorityBatch, "b0", "job1"))
	victim := enqueueAsync(s, PriorityBatch, "b1", "job1")
	time.Sleep(100 * time.Millisecond)
	s.CancelBatch("job1")
	select {
	case res := <-victim:
		if !errors.Is(res.err, ErrSuperseded) {
			t.Fatalf("expected cancellation, got %v", res.err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("victim waiter never returned")
	}
	// Other batches are unaffected.
	other := enqueueAsync(s, PriorityBatch, "b9", "job2")
	time.Sleep(100 * time.Millisecond)
	s.Release(running)
	s.Release(awaitGrant(t, other))
}
