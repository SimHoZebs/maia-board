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

// Sync focus is single-flight depth-1: a newer focus cancels queued stale
// focus and the cancelled waiter never consumes the slot.
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

// Play is depth-1 latest-wins like Focus: a newer Play supersedes queued Play.
func TestSchedulerPlayDepthOneSupersedes(t *testing.T) {
	s := NewScheduler()
	running := awaitGrant(t, enqueueAsync(s, PriorityBatch, "b0", "job1"))

	playA := enqueueAsync(s, PriorityPlay, "pA", "")
	time.Sleep(100 * time.Millisecond)
	playB := enqueueAsync(s, PriorityPlay, "pB", "")
	select {
	case res := <-playA:
		if !errors.Is(res.err, ErrSuperseded) {
			t.Fatalf("stale play must be superseded, got %v", res.err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("stale play waiter never returned")
	}
	s.Release(running)
	s.Release(awaitGrant(t, playB))
	if !s.Idle() {
		t.Fatal("slot leaked after depth-1 supersede")
	}
}

// Grant order is Play>Focus>Batch regardless of arrival order.
func TestSchedulerLaneOrder(t *testing.T) {
	s := NewScheduler()
	running := awaitGrant(t, enqueueAsync(s, PriorityBatch, "b0", "job1"))

	b1 := enqueueAsync(s, PriorityBatch, "b1", "job1")
	time.Sleep(50 * time.Millisecond)
	f1 := enqueueAsync(s, PriorityFocus, "f1", "")
	time.Sleep(50 * time.Millisecond)
	p1 := enqueueAsync(s, PriorityPlay, "p1", "")
	time.Sleep(100 * time.Millisecond)

	s.Release(running)
	// Play first, then Focus, then Batch.
	s.Release(awaitGrant(t, p1))
	s.Release(awaitGrant(t, f1))
	s.Release(awaitGrant(t, b1))
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

// Dedup spans lanes: a Focus duplicate of a running Play joins instead of queueing.
func TestSchedulerDedupAcrossLanes(t *testing.T) {
	s := NewScheduler()
	running := awaitGrant(t, enqueueAsync(s, PriorityPlay, "dup", ""))
	joiner := enqueueAsync(s, PriorityFocus, "dup", "")
	time.Sleep(100 * time.Millisecond)
	s.Release(running)
	select {
	case res := <-joiner:
		if res.err != nil || !res.joined {
			t.Fatalf("cross-lane duplicate must join, err=%v joined=%v", res.err, res.joined)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("cross-lane joiner never returned")
	}
}

// Empty keys never dedup: two empty-key batch tickets queue independently.
func TestSchedulerEmptyKeyNeverDedups(t *testing.T) {
	s := NewScheduler()
	running := awaitGrant(t, enqueueAsync(s, PriorityBatch, "b0", "job1"))
	a := enqueueAsync(s, PriorityBatch, "", "job1")
	time.Sleep(100 * time.Millisecond)
	b := enqueueAsync(s, PriorityBatch, "", "job1")
	time.Sleep(100 * time.Millisecond)
	s.Release(running)
	s.Release(awaitGrant(t, a))
	s.Release(awaitGrant(t, b))
	if !s.Idle() {
		t.Fatal("empty-key tickets leaked")
	}
}

// Batch is unbounded FIFO: three queued batch tickets grant in order.
func TestSchedulerBatchFIFO(t *testing.T) {
	s := NewScheduler()
	running := awaitGrant(t, enqueueAsync(s, PriorityBatch, "b0", "job1"))
	b1 := enqueueAsync(s, PriorityBatch, "b1", "job1")
	time.Sleep(100 * time.Millisecond)
	b2 := enqueueAsync(s, PriorityBatch, "b2", "job1")
	time.Sleep(100 * time.Millisecond)
	b3 := enqueueAsync(s, PriorityBatch, "b3", "job1")
	time.Sleep(100 * time.Millisecond)
	s.Release(running)
	s.Release(awaitGrant(t, b1))
	s.Release(awaitGrant(t, b2))
	s.Release(awaitGrant(t, b3))
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

// ctx-cancel while queued drops the ticket: the cancelled waiter gets
// ctx.Err, leaves no residue, and the next waiter is granted.
func TestSchedulerContextCancelDropsQueued(t *testing.T) {
	s := NewScheduler()
	running := awaitGrant(t, enqueueAsync(s, PriorityBatch, "b0", "job1"))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, _, err := s.Acquire(ctx, PriorityBatch, "b1", "job1")
		done <- err
	}()
	time.Sleep(100 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("expected canceled, got %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("cancelled waiter never returned")
	}
	next := enqueueAsync(s, PriorityBatch, "b2", "job1")
	time.Sleep(100 * time.Millisecond)
	s.Release(running)
	s.Release(awaitGrant(t, next))
	if !s.Idle() {
		t.Fatal("cancelled ticket left residue")
	}
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
