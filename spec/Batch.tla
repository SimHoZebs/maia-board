---- MODULE Batch ----
(*
  Batch review jobs (TLA+, TLC-checked).
  Grounding (backend/reviews.go):
  - entry/job types: 224-267; caps: 16-29
  - intake: 537-629 (validate all, prefetch filter, hits settle at intake,
    2-attempt cap re-check, one submitSeq per accepted submit, evictLocked)
  - drain/claim/runEntry/complete: 671-707, 709-730, 744-766, 294-323
  - eviction: 423-450 (finished-only, never unfinished/just-inserted)
  - status truth, no DELETE: 642-660; stream as optimization: 771+
  - strictBatch: degraded -> per-index failure (92-134)

  Scheduler grants abstracted: each entry holds its engine slot for that
  entry only (yield to Play/Focus between entries). Cache = settled id set.
*)

EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS JobIds, EntryIds, MaxReqs, MaxKept, MaxUnfinished, Null

(* submitSeq (the rotation nonce, reviews.go:604) is intentionally not a
   TLC variable: rotation order is Scheduler.tla's job, and a monotonic
   counter would manufacture terminal deadlock at its bound. Intake here
   stays deadlock-free: with MaxKept < Cardinality(JobIds), a fresh id is
   always available whenever eviction cannot fire. *)

VARIABLES jobs, order, cacheHits

vars == <<jobs, order, cacheHits>>

UnfinishedCount == Cardinality({j \in DOMAIN jobs : jobs[j].finished = FALSE})

AddJob(val) == [j \in DOMAIN jobs \cup {val.jid} |->
    IF j = val.jid THEN [entries |-> val.entries, done |-> val.done,
                         failed |-> 0, finished |-> FALSE]
    ELSE jobs[j]]

DelJob(jid) == [j \in DOMAIN jobs \ {jid} |-> jobs[j]]

TypeOK ==
    /\ \A j \in DOMAIN jobs :
        /\ Len(jobs[j].entries) <= MaxReqs
        /\ \A i \in 1..Len(jobs[j].entries) : jobs[j].entries[i] \in {"pending", "running", "done", "failed"}
        /\ jobs[j].done + jobs[j].failed <= Len(jobs[j].entries)
        /\ jobs[j].finished \in {TRUE, FALSE}

Init ==
    /\ jobs = [j \in {} |-> [entries |-> <<>>, done |-> 0, failed |-> 0, finished |-> FALSE]]
    /\ order = <<>>
    /\ cacheHits = {}

(* Intake: cached hits settle immediately; misses stay pending. Rejected
   submits consume no nonce. submitSeq bounded for TLC (not a system cap). *)
Submit(jid, n, c) ==
    /\ jid \in JobIds \ DOMAIN jobs
    /\ n \in 1..2 /\ c \in 0..n
    /\ UnfinishedCount < MaxUnfinished
    /\ jobs' = AddJob([jid |-> jid,
                        entries |-> [i \in 1..n |-> IF i <= c THEN "done" ELSE "pending"],
                        done |-> c])
    /\ order' = Append(order, jid)
    /\ UNCHANGED cacheHits

Claim(jid, idx) ==
    /\ jid \in DOMAIN jobs /\ jobs[jid].finished = FALSE
    /\ idx \in 1..Len(jobs[jid].entries) /\ jobs[jid].entries[idx] = "pending"
    /\ jobs' = [jobs EXCEPT ![jid].entries[idx] = "running"]
    /\ UNCHANGED <<order, cacheHits>>

(* strictBatch: compute-then-store -> done (+cacheHits); any error incl.
   degraded -> failed per-index so live can retry. *)
SucceedEntry(jid, idx, eid) ==
    /\ jid \in DOMAIN jobs /\ jobs[jid].finished = FALSE
    /\ idx \in 1..Len(jobs[jid].entries) /\ jobs[jid].entries[idx] = "running"
    /\ eid \in EntryIds
    /\ jobs' = [jobs EXCEPT ![jid].entries[idx] = "done",
                               ![jid].done = @ + 1]
    /\ cacheHits' = cacheHits \cup {eid}
    /\ UNCHANGED order

FailEntry(jid, idx) ==
    /\ jid \in DOMAIN jobs /\ jobs[jid].finished = FALSE
    /\ idx \in 1..Len(jobs[jid].entries) /\ jobs[jid].entries[idx] = "running"
    /\ jobs' = [jobs EXCEPT ![jid].entries[idx] = "failed",
                               ![jid].failed = @ + 1]
    /\ UNCHANGED <<order, cacheHits>>

FinishJob(jid) ==
    /\ jid \in DOMAIN jobs /\ jobs[jid].finished = FALSE
    /\ \A i \in 1..Len(jobs[jid].entries) : jobs[jid].entries[i] \in {"done", "failed"}
    /\ jobs' = [jobs EXCEPT ![jid].finished = TRUE]
    /\ UNCHANGED <<order, cacheHits>>

(* Eviction scans for the first finished job anywhere (not head-only);
   unfinished jobs are never evicted. Settled work survives via cacheHits. *)
EvictJob ==
    /\ Len(order) > MaxKept
    /\ \E i \in 1..Len(order) :
        LET jid == order[i] IN
        /\ jid \in DOMAIN jobs /\ jobs[jid].finished = TRUE
        /\ \A k \in 1..(i - 1) : order[k] \notin DOMAIN jobs \/ jobs[order[k]].finished = FALSE
        /\ jobs' = DelJob(jid)
        /\ order' = SubSeq(order, 1, i - 1) \o SubSeq(order, i + 1, Len(order))
    /\ UNCHANGED cacheHits

Next ==
    \/ \E jid \in JobIds, n \in 1..2, c \in 0..2 : Submit(jid, n, c)
    \/ \E jid \in JobIds, idx \in 1..3 : Claim(jid, idx)
    \/ \E jid \in JobIds, idx \in 1..3, eid \in EntryIds : SucceedEntry(jid, idx, eid)
    \/ \E jid \in JobIds, idx \in 1..3 : FailEntry(jid, idx)
    \/ \E jid \in JobIds : FinishJob(jid)
    \/ EvictJob

Spec == Init /\ [][Next]_vars

(* Safety *)
EntryOnce ==
    \A j \in DOMAIN jobs : jobs[j].done + jobs[j].failed <= Len(jobs[j].entries)
UnfinishedBound == UnfinishedCount <= MaxUnfinished
FinishedNeedsAllSettled ==
    \A j \in DOMAIN jobs : jobs[j].finished = TRUE =>
        \A i \in 1..Len(jobs[j].entries) : jobs[j].entries[i] \in {"done", "failed"}
Safety == TypeOK /\ EntryOnce /\ UnfinishedBound /\ FinishedNeedsAllSettled

(* TLC run 2026-09-23: JobIds={"j1","j2","j3"}, EntryIds={"e1","e2","e3"},
   MaxReqs=3, MaxKept=2, MaxUnfinished=2.
   358,621 distinct states, depth 31, no errors, full coverage. *)
====
