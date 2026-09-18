package main

import (
	"context"
	"errors"
)

// admit centralizes sync-wait + Scheduler.Acquire + error mapping shared by
// the Maia worker (Worker.predict) and the Stockfish evaluator
// (Evaluator.run). Per-engine timeouts, schedulerFor dual-slot routing, and
// process lifecycle stay with the callers.
func admit(waitCtx context.Context, prio Priority, sched *Scheduler, key string, submitSeq uint64) (*Grant, error) {
	wait := waitCtx
	cancel := context.CancelFunc(func() {})
	if prio != PriorityBatch {
		wait, cancel = context.WithTimeout(waitCtx, syncWait(prio))
	}
	grant, joined, err := sched.Acquire(wait, prio, key, submitSeq)
	cancel()
	if err != nil {
		switch {
		case errors.Is(err, ErrSchedulerBusy):
			return nil, ErrWorkerBusy
		case errors.Is(err, ErrSuperseded):
			return nil, err
		case waitCtx.Err() != nil:
			return nil, waitCtx.Err()
		default:
			return nil, ErrWorkerBusy
		}
	}
	if joined {
		return nil, ErrJoined
	}
	return grant, nil
}
