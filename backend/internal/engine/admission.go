package engine

import (
	"context"
	"errors"

	"maia-board/backend/internal/sched"
)

// Admit centralizes sync-wait + Scheduler.Acquire + error mapping shared by
// the Maia worker (Worker.Predict) and the Stockfish evaluator
// (Evaluator.Run), and reused by test predictors that admit exactly like
// production. Per-engine timeouts, schedulerFor dual-slot routing, and
// process lifecycle stay with the callers.
func Admit(waitCtx context.Context, prio sched.Priority, s *sched.Scheduler, key string, submitSeq uint64) (*sched.Grant, error) {
	wait := waitCtx
	cancel := context.CancelFunc(func() {})
	if prio != sched.PriorityBatch {
		wait, cancel = context.WithTimeout(waitCtx, syncWait(prio))
	}
	grant, joined, err := s.Acquire(wait, prio, key, submitSeq)
	cancel()
	if err != nil {
		switch {
		case errors.Is(err, sched.ErrSchedulerBusy):
			return nil, ErrWorkerBusy
		case errors.Is(err, sched.ErrSuperseded):
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
