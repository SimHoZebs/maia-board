package main

import (
	"context"
	"errors"
	"sync"
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
	key     string
	prio    Priority
	batchID string
	seq     uint64
	grant   chan struct{} // closed when this ticket owns the slot
	done    chan struct{} // closed on completion or cancellation
	state   ticketState
	joined  bool // waiters joined an existing ticket instead of queueing
}

// Grant owns one admission slot until Release is called.
type Grant struct {
	s *Scheduler
	t *ticket
}

// Scheduler orders admission to a single-slot engine across three FIFO lanes.
// Lane derives from the endpoint (/move→Play, /evaluate→Focus, /reviews→Batch);
// the X-Priority header is ignored (legacy clients may still send it).
// It owns ordering and cancellation only; execution stays with the caller
// (Worker.predict / Evaluator.run), which keeps its own timeouts and process
// lifecycle. The zero value is unusable; use NewScheduler.
//
// Depths: Play 1 latest-wins, Focus 1 latest-wins (a new arrival replaces the
// queued waiter, which gets ErrSuperseded and never consumes the slot),
// Batch unbounded FIFO. Dedup-by-key spans lanes; empty keys never dedup.
// Grant order is Play>Focus>Batch, non-preemptive (a grant waits at most one op).
type Scheduler struct {
	mu      sync.Mutex
	queues  [3][]*ticket
	running *ticket
	byKey   map[string]*ticket
	seq     uint64
}

func NewScheduler() *Scheduler {
	return &Scheduler{byKey: make(map[string]*ticket)}
}

// Acquire blocks until this key owns the slot, another caller completes the
// same deterministic key (joined=true, caller should re-read the cache), or
// ctx expires. An empty key disables dedup (sampled requests are unique).
func (s *Scheduler) Acquire(ctx context.Context, prio Priority, key, batchID string) (*Grant, bool, error) {
	if key != "" {
		if grant, joined, err := s.join(ctx, key); err != nil || joined {
			return grant, joined, err
		}
	}
	t := s.enqueue(prio, key, batchID)
	select {
	case <-t.grant:
		return &Grant{s: s, t: t}, false, nil
	case <-t.done:
		// Done fires while queued only via cancellation (CancelQueued,
		// CancelBatch, or Play/Focus depth-1 single-flight): a newer request
		// superseded this one, so it must not consume the engine.
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
// which gets ErrSuperseded. Batch is unbounded FIFO.
func (s *Scheduler) enqueue(prio Priority, key, batchID string) *ticket {
	s.mu.Lock()
	defer s.mu.Unlock()
	if batchID == "" && (prio == PriorityPlay || prio == PriorityFocus) {
		s.cancelLocked(func(t *ticket) bool {
			return t.state == ticketQueued && t.prio == prio && t.batchID == ""
		})
	}
	s.seq++
	t := &ticket{key: key, prio: prio, batchID: batchID, seq: s.seq, grant: make(chan struct{}), done: make(chan struct{})}
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

// CancelQueued drops a single queued ticket (stale focus). Running work is
// never killed: at most one op is wasted.
func (s *Scheduler) CancelQueued(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.byKey[key]
	if !ok || t.state != ticketQueued {
		return
	}
	s.removeLocked(t)
	t.state = ticketCancelled
	delete(s.byKey, key)
	close(t.done)
	s.pumpLocked()
}

// CancelBatch drops every queued ticket of a batch. Running batch work
// finishes and still writes through to the cache.
func (s *Scheduler) CancelBatch(batchID string) {
	if batchID == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cancelLocked(func(t *ticket) bool {
		return t.state == ticketQueued && t.batchID == batchID
	})
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
// slot is free. Callers hold s.mu.
func (s *Scheduler) pumpLocked() {
	if s.running != nil {
		return
	}
	for prio := PriorityPlay; prio <= PriorityBatch; prio++ {
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
}
