package main

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
)

// Priority lanes for engine admission. Lower value wins; the running operation
// always runs to completion (non-preemptive): a grant waits at most one op.
type Priority int

const (
	PriorityPlay Priority = iota
	PriorityFocus
	PriorityBatch
)

// ErrSchedulerBusy maps to 503: the bounded admission wait expired while a
// longer-than-expected operation held the single slot. Queues themselves are
// unbounded (interactive lanes latest-wins at depth 1, batch FIFO), so this
// signals overload, never lane-full.
var ErrSchedulerBusy = errors.New("engine scheduler is busy")

var ErrSuperseded = errors.New("superseded by newer request")

type ticketState int

const (
	ticketQueued ticketState = iota
	ticketRunning
	ticketCompleted
	ticketCancelled
)

type ticket struct {
	key       string
	prio      Priority
	submitSeq uint64 // rotation group (§1); 0 = sync sentinel, excluded from scan
	seq       uint64
	grant     chan struct{} // closed when this ticket owns the slot
	done      chan struct{} // closed on completion or cancellation
	state     ticketState
	joined    bool // waiters joined an existing ticket instead of queueing
}

// submitSeqCounter is the process-wide submit nonce source (§1). One
// nextSubmitSeq call per accepted submit; tests and later intake code call it
// to stamp a whole submit group. Starts at 1 so 0 stays the sync sentinel.
var submitSeqCounter atomic.Uint64

func nextSubmitSeq() uint64 {
	return submitSeqCounter.Add(1)
}

// Grant owns one admission slot until Release is called.
type Grant struct {
	s *Scheduler
	t *ticket
}

// Scheduler orders admission to a single-slot engine across three FIFO lanes.
// Lane derives from the endpoint (/move→Play, /move/analysis→Focus,
// /evaluate→Focus, /reviews→Batch); the X-Priority header is ignored
// (legacy clients may still send it). The /move vs /move/analysis split is
// intentional: a live reply and its analysis fire together every move, and
// same-lane arrivals supersede instead of queueing, so merging them would
// 409 the live reply.
// It owns ordering and cancellation only; execution stays with the caller
// (Worker.predict / Evaluator.run), which keeps its own timeouts and process
// lifecycle. The zero value is unusable; use NewScheduler.
//
// Depths: Play 1 latest-wins, Focus 1 latest-wins (a new arrival replaces the
// queued waiter, which gets ErrSuperseded and never consumes the slot),
// Batch unbounded FIFO. Dedup-by-key spans lanes; empty keys never dedup.
// Grant order is Play>Focus>Batch, non-preemptive (a grant waits at most one op).
type Scheduler struct {
	mu          sync.Mutex
	queues      [3][]*ticket
	running     *ticket
	byKey       map[string]*ticket
	seq         uint64
	batchCursor uint64 // last-served batch submitSeq, per scheduler (§1)
}

func NewScheduler() *Scheduler {
	return &Scheduler{byKey: make(map[string]*ticket)}
}

// Acquire blocks until this key owns the slot, another caller completes the
// same deterministic key (joined=true, caller should re-read the cache), or
// ctx expires. An empty key disables dedup (sampled requests are unique).
// submitSeq orders the batch lane (rotation groups); sync callers pass 0.
func (s *Scheduler) Acquire(ctx context.Context, prio Priority, key string, submitSeq uint64) (*Grant, bool, error) {
	if key != "" {
		if grant, joined, err := s.join(ctx, key); err != nil || joined {
			return grant, joined, err
		}
	}
	t := s.enqueue(prio, key, submitSeq)
	select {
	case <-t.grant:
		return &Grant{s: s, t: t}, false, nil
	case <-t.done:
		// Done fires while queued only via sync-lane single-flight
		// replacement: a newer request superseded this one, so it must not
		// consume the engine.
		return nil, false, ErrSuperseded
	case <-ctx.Done():
		// Grant and cancellation race: pumpLocked closes grant under s.mu,
		// so state==running under lock means this waiter owns the slot.
		s.mu.Lock()
		granted := t.state == ticketRunning
		if !granted {
			s.removeLocked(t)
			// Cancelled, not completed: joiners loop and enqueue fresh
			// instead of trusting a cache row that was never written.
			t.state = ticketCancelled
			if t.key != "" {
				delete(s.byKey, t.key)
			}
			close(t.done)
			s.pumpLocked()
		}
		s.mu.Unlock()
		if granted {
			return &Grant{s: s, t: t}, false, nil
		}
		return nil, false, ctx.Err()
	}
}

// join waits on an in-flight duplicate key. It returns joined=true once the
// owner completes; a cancelled owner makes the joiner enqueue normally.
func (s *Scheduler) join(ctx context.Context, key string) (*Grant, bool, error) {
	for {
		s.mu.Lock()
		t, ok := s.byKey[key]
		s.mu.Unlock()
		if !ok {
			return nil, false, nil
		}
		select {
		case <-t.done:
			if t.state == ticketCompleted {
				return nil, true, nil
			}
			// Cancelled owner: loop around and enqueue fresh.
		case <-ctx.Done():
			return nil, false, ctx.Err()
		}
	}
}

// enqueue appends a ticket and returns it. Sync lanes (Play, Focus) are
// single-flight depth-1 latest-wins: a new arrival replaces the queued waiter,
// which gets ErrSuperseded. The batch lane rotates across submitSeq groups
// (see pumpLocked); 0 is the sync sentinel and never matches the scan.
func (s *Scheduler) enqueue(prio Priority, key string, submitSeq uint64) *ticket {
	s.mu.Lock()
	defer s.mu.Unlock()
	if submitSeq == 0 && (prio == PriorityPlay || prio == PriorityFocus) {
		s.cancelLocked(func(t *ticket) bool {
			return t.state == ticketQueued && t.prio == prio && t.submitSeq == 0
		})
	}
	s.seq++
	t := &ticket{key: key, prio: prio, submitSeq: submitSeq, seq: s.seq, grant: make(chan struct{}), done: make(chan struct{})}
	s.queues[prio] = append(s.queues[prio], t)
	if key != "" {
		s.byKey[key] = t
	}
	s.pumpLocked()
	return t
}

// Release completes the grant; joiners observe joined=true.
func (s *Scheduler) Release(g *Grant) {
	if g == nil || g.t == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running != g.t {
		return
	}
	g.t.state = ticketCompleted
	s.running = nil
	if g.t.key != "" {
		delete(s.byKey, g.t.key)
	}
	close(g.t.done)
	s.pumpLocked()
}

func (s *Scheduler) cancelLocked(match func(*ticket) bool) {
	for prio := range s.queues {
		kept := s.queues[prio][:0]
		for _, t := range s.queues[prio] {
			if match(t) {
				t.state = ticketCancelled
				if t.key != "" {
					delete(s.byKey, t.key)
				}
				close(t.done)
				continue
			}
			kept = append(kept, t)
		}
		s.queues[prio] = kept
	}
}

func (s *Scheduler) removeLocked(target *ticket) {
	queue := s.queues[target.prio][:0]
	for _, t := range s.queues[target.prio] {
		if t != target {
			queue = append(queue, t)
		}
	}
	s.queues[target.prio] = queue
}

// Idle reports whether no ticket is running or queued.
func (s *Scheduler) Idle() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running != nil {
		return false
	}
	for prio := range s.queues {
		if len(s.queues[prio]) != 0 {
			return false
		}
	}
	return true
}

// pumpLocked grants the head of the highest-priority non-empty lane when the
// slot is free. Play/Focus stay head-pick; the batch lane rotates across
// submitSeq groups (§1): smallest submitSeq strictly greater than the cursor,
// else smallest present (wrap); FIFO by global seq within a group. Sentinel 0
// never matches the scan (sync tickets live in higher lanes anyway); a batch
// grant with nonzero submitSeq advances the cursor, sync grants never touch
// it. Drained groups vanish by absence. Callers hold s.mu.
func (s *Scheduler) pumpLocked() {
	if s.running != nil {
		return
	}
	for prio := PriorityPlay; prio <= PriorityFocus; prio++ {
		if len(s.queues[prio]) == 0 {
			continue
		}
		t := s.queues[prio][0]
		s.queues[prio] = s.queues[prio][1:]
		t.state = ticketRunning
		s.running = t
		close(t.grant)
		return
	}
	if len(s.queues[PriorityBatch]) == 0 {
		return
	}
	idx := s.pickBatchLocked()
	t := s.queues[PriorityBatch][idx]
	s.queues[PriorityBatch] = append(s.queues[PriorityBatch][:idx], s.queues[PriorityBatch][idx+1:]...)
	t.state = ticketRunning
	s.running = t
	if t.submitSeq != 0 {
		s.batchCursor = t.submitSeq
	}
	close(t.grant)
}

// pickBatchLocked selects the batch queue index per the rotation rule.
// Callers hold s.mu. Queues without stamped groups (all submitSeq 0, e.g.
// sync overflow which cannot happen by lane) fall back to head-pick.
func (s *Scheduler) pickBatchLocked() int {
	q := s.queues[PriorityBatch]
	best := -1
	var bestGroup, bestOrd uint64
	for i, t := range q {
		if t.submitSeq == 0 || t.submitSeq <= s.batchCursor {
			continue
		}
		if best == -1 || t.submitSeq < bestGroup || (t.submitSeq == bestGroup && t.seq < bestOrd) {
			best, bestGroup, bestOrd = i, t.submitSeq, t.seq
		}
	}
	if best != -1 {
		return best
	}
	for i, t := range q {
		if t.submitSeq == 0 {
			continue
		}
		if best == -1 || t.submitSeq < bestGroup || (t.submitSeq == bestGroup && t.seq < bestOrd) {
			best, bestGroup, bestOrd = i, t.submitSeq, t.seq
		}
	}
	if best != -1 {
		return best
	}
	return 0
}
