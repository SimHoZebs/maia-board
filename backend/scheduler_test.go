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
func enqueueAsync(s *Scheduler, prio Priority, key string, submitSeq uint64) <-chan acquireResult {
	out := make(chan acquireResult, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		grant, joined, err := s.Acquire(ctx, prio, key, submitSeq)
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
	running := awaitGrant(t, enqueueAsync(s, PriorityBatch, "b0", 1))

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
	b1 := enqueueAsync(s, PriorityBatch, "b1", 1)
	time.Sleep(100 * time.Millisecond)
	p1 := enqueueAsync(s, PriorityPlay, "p1", 0)
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
	running := awaitGrant(t, enqueueAsync(s, PriorityBatch, "b0", 1))

	focusA := enqueueAsync(s, PriorityFocus, "fA", 0)
	time.Sleep(100 * time.Millisecond)
	focusB := enqueueAsync(s, PriorityFocus, "fB", 0)
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
	running := awaitGrant(t, enqueueAsync(s, PriorityBatch, "b0", 1))

	playA := enqueueAsync(s, PriorityPlay, "pA", 0)
	time.Sleep(100 * time.Millisecond)
	playB := enqueueAsync(s, PriorityPlay, "pB", 0)
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
	running := awaitGrant(t, enqueueAsync(s, PriorityBatch, "b0", 1))

	b1 := enqueueAsync(s, PriorityBatch, "b1", 1)
	time.Sleep(50 * time.Millisecond)
	f1 := enqueueAsync(s, PriorityFocus, "f1", 0)
	time.Sleep(50 * time.Millisecond)
	p1 := enqueueAsync(s, PriorityPlay, "p1", 0)
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
	running := awaitGrant(t, enqueueAsync(s, PriorityBatch, "dup", 1))
	joiner := enqueueAsync(s, PriorityBatch, "dup", 1)
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
	running := awaitGrant(t, enqueueAsync(s, PriorityPlay, "dup", 0))
	joiner := enqueueAsync(s, PriorityFocus, "dup", 0)
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
	running := awaitGrant(t, enqueueAsync(s, PriorityBatch, "b0", 1))
	a := enqueueAsync(s, PriorityBatch, "", 1)
	time.Sleep(100 * time.Millisecond)
	b := enqueueAsync(s, PriorityBatch, "", 1)
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
	running := awaitGrant(t, enqueueAsync(s, PriorityBatch, "b0", 1))
	b1 := enqueueAsync(s, PriorityBatch, "b1", 1)
	time.Sleep(100 * time.Millisecond)
	b2 := enqueueAsync(s, PriorityBatch, "b2", 1)
	time.Sleep(100 * time.Millisecond)
	b3 := enqueueAsync(s, PriorityBatch, "b3", 1)
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
	running := awaitGrant(t, enqueueAsync(s, PriorityBatch, "b0", 1))
	short, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, _, err := s.Acquire(short, PriorityBatch, "b1", 1); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline, got %v", err)
	}
	next := enqueueAsync(s, PriorityBatch, "b2", 1)
	time.Sleep(100 * time.Millisecond)
	s.Release(running)
	s.Release(awaitGrant(t, next))
}

// ctx-cancel while queued drops the ticket: the cancelled waiter gets
// ctx.Err, leaves no residue, and the next waiter is granted.
func TestSchedulerContextCancelDropsQueued(t *testing.T) {
	s := NewScheduler()
	running := awaitGrant(t, enqueueAsync(s, PriorityBatch, "b0", 1))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, _, err := s.Acquire(ctx, PriorityBatch, "b1", 1)
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
	next := enqueueAsync(s, PriorityBatch, "b2", 1)
	time.Sleep(100 * time.Millisecond)
	s.Release(running)
	s.Release(awaitGrant(t, next))
	if !s.Idle() {
		t.Fatal("cancelled ticket left residue")
	}
}

// ---- §1 rotation tests: synchronous direct drive, no timing. ----

func runningKey(s *Scheduler) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running == nil {
		return ""
	}
	return s.running.key
}

func releaseRunning(t *testing.T, s *Scheduler) {
	t.Helper()
	s.mu.Lock()
	r := s.running
	s.mu.Unlock()
	if r == nil {
		t.Fatal("no running ticket to release")
	}
	s.Release(&Grant{s: s, t: r})
}

// Solo group: one submitSeq → head-pick every grant → bit-identical to FIFO.
func TestSchedulerBatchSoloFIFO(t *testing.T) {
	s := NewScheduler()
	seq := nextSubmitSeq()
	s.enqueue(PriorityBatch, "a1", seq)
	s.enqueue(PriorityBatch, "a2", seq)
	s.enqueue(PriorityBatch, "a3", seq)
	for _, want := range []string{"a1", "a2", "a3"} {
		if got := runningKey(s); got != want {
			t.Fatalf("solo FIFO: got running %q, want %q", got, want)
		}
		releaseRunning(t, s)
	}
	if !s.Idle() {
		t.Fatal("solo group did not drain")
	}
}

// A then B: A,B,A,B — B starts on the second grant.
func TestSchedulerBatchInterleaveAB(t *testing.T) {
	s := NewScheduler()
	seqA := nextSubmitSeq()
	seqB := nextSubmitSeq()
	s.enqueue(PriorityBatch, "a1", seqA)
	s.enqueue(PriorityBatch, "a2", seqA)
	s.enqueue(PriorityBatch, "b1", seqB)
	s.enqueue(PriorityBatch, "b2", seqB)
	for _, want := range []string{"a1", "b1", "a2", "b2"} {
		if got := runningKey(s); got != want {
			t.Fatalf("interleave: got running %q, want %q", got, want)
		}
		releaseRunning(t, s)
	}
	if !s.Idle() {
		t.Fatal("interleaved groups did not drain")
	}
}

// C joins the rotation on the next grant after arrival.
func TestSchedulerBatchJoinCNextGrant(t *testing.T) {
	s := NewScheduler()
	seqA := nextSubmitSeq()
	seqB := nextSubmitSeq()
	s.enqueue(PriorityBatch, "a1", seqA)
	s.enqueue(PriorityBatch, "a2", seqA)
	s.enqueue(PriorityBatch, "b1", seqB)
	if got := runningKey(s); got != "a1" {
		t.Fatalf("setup: got %q, want a1", got)
	}
	releaseRunning(t, s) // grants b1, cursor at max
	if got := runningKey(s); got != "b1" {
		t.Fatalf("setup: got %q, want b1", got)
	}
	seqC := nextSubmitSeq()
	s.enqueue(PriorityBatch, "c1", seqC)
	releaseRunning(t, s) // only C exceeds cursor → C next
	if got := runningKey(s); got != "c1" {
		t.Fatalf("join: got %q, want c1 next", got)
	}
	releaseRunning(t, s)
	if got := runningKey(s); got != "a2" {
		t.Fatalf("after C: got %q, want a2", got)
	}
	releaseRunning(t, s)
	if !s.Idle() {
		t.Fatal("join test did not drain")
	}
}

// Orphan (single-ticket group) drains fairly and vanishes by absence.
func TestSchedulerBatchOrphanDrains(t *testing.T) {
	s := NewScheduler()
	seqA := nextSubmitSeq()
	seqB := nextSubmitSeq()
	s.enqueue(PriorityBatch, "a1", seqA)
	s.enqueue(PriorityBatch, "a2", seqA)
	s.enqueue(PriorityBatch, "b1", seqB) // orphan
	for _, want := range []string{"a1", "b1", "a2"} {
		if got := runningKey(s); got != want {
			t.Fatalf("orphan: got %q, want %q", got, want)
		}
		releaseRunning(t, s)
	}
	if !s.Idle() {
		t.Fatal("orphan group left residue")
	}
}

// Wrap: when nothing exceeds the cursor, serve the smallest present.
func TestSchedulerBatchWrap(t *testing.T) {
	s := NewScheduler()
	seqA := nextSubmitSeq()
	seqB := nextSubmitSeq()
	s.enqueue(PriorityBatch, "a1", seqA)
	s.enqueue(PriorityBatch, "b1", seqB)
	releaseRunning(t, s)                 // grants b1, cursor at max (seqB)
	s.enqueue(PriorityBatch, "a2", seqA) // late old-group arrival
	releaseRunning(t, s)
	if got := runningKey(s); got != "a2" {
		t.Fatalf("wrap: got %q, want a2 (smallest present)", got)
	}
	releaseRunning(t, s)
	if !s.Idle() {
		t.Fatal("wrap test did not drain")
	}
}
