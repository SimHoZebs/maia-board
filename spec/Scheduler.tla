---- MODULE Scheduler ----
(*
  Scheduler + admission caps (TLA+, TLC-checked).
  Grounding (backend/):
  - lanes/priority/supersede/dedup: scheduler.go:63-77, 95-132, 156-176
  - pump + batch rotation: scheduler.go:247-306
  - admit mapping: admission.go:12-36
  - caps/counts/429/intake: reviews.go:16-29, 354-415, 537-629
  - per-slot split: evaluate.go:73-80 (SF interactive vs batch instances);
    Maia shares one Worker.sched across Play/Focus/Batch (engine.go:108-119)

  Scope: ONE scheduler instance. Model SF as two instances of this module.
  Faithful simplifications: per-group FIFO follows queue order (no ord field);
  re-check+insert is one atomic step mirroring the js.mu hold
  (reviews.go:579-601) — atomicity itself is assumed, cap arithmetic is checked.
*)

EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS Keys, MaxMisses, MaxUnfinished

(* TLC cannot compare a record with a non-record string sentinel, so the
   slot is modeled as a busy flag plus an always-well-typed ticket holder
   instead of ticket ∪ {Null}. *)
VARIABLES queues, busy, runTicket, cursor, tallies, batchSawBusy

vars == <<queues, busy, runTicket, cursor, tallies, batchSawBusy>>

SampledKey == ""
SyncPrios == {1, 2}

QueuedKeys ==
    UNION {{queues[p][i].key : i \in 1..Len(queues[p])} : p \in 1..3}
    \cup IF busy THEN {runTicket.key} ELSE {}

TypeOK ==
    /\ \A p \in 1..3 : \A i \in 1..Len(queues[p]) :
        /\ queues[p][i].key \in Keys \cup {SampledKey}
        /\ queues[p][i].group \in Nat
    /\ busy \in {TRUE, FALSE}
    /\ runTicket.key \in Keys \cup {SampledKey}
    /\ runTicket.group \in Nat
    /\ cursor \in Nat
    /\ tallies.unfinished \in Nat /\ tallies.sf \in Nat
    /\ tallies.large \in Nat /\ tallies.small \in Nat
    /\ batchSawBusy \in Nat

Init ==
    /\ queues = [p \in 1..3 |-> <<>>]
    /\ busy = FALSE
    /\ runTicket = [key |-> "k1", group |-> 0]
    /\ cursor = 0
    /\ tallies = [unfinished |-> 0, sf |-> 0, large |-> 0, small |-> 0]
    /\ batchSawBusy = 0

(* Sync lanes: depth-1 latest-wins; arrivals replace the queued waiter,
   which observes ErrSuperseded. Sampled ("") queues normally, never joins. *)
EnqueueSync(prio, key) ==
    /\ prio \in SyncPrios
    /\ key \in Keys \cup {SampledKey}
    /\ queues' = [queues EXCEPT ![prio] = <<[key |-> key, group |-> 0]>>]
    /\ UNCHANGED <<busy, runTicket, cursor, tallies, batchSawBusy>>

(* Batch lane: bounded FIFO within rotation groups (TLC bound, not a cap). *)
EnqueueBatch(key, group) ==
    /\ key \in Keys
    /\ group \in 1..2
    /\ Len(queues[3]) < 3
    /\ queues' = [queues EXCEPT ![3] = Append(@, [key |-> key, group |-> group])]
    /\ UNCHANGED <<busy, runTicket, cursor, tallies, batchSawBusy>>

(* Deterministic duplicates join the owner and re-read cache afterwards. *)
JoinHit(key) ==
    /\ key \in Keys
    /\ key \in QueuedKeys
    /\ UNCHANGED vars

GroupsPresent(q) == {q[i].group : i \in 1..Len(q)} \ {0}

ChooseGroup(q, c) ==
    LET present == GroupsPresent(q) IN
    IF present = {}
    THEN 0
    ELSE IF \E g \in present : g > c
         THEN CHOOSE g \in present : g > c /\ \A h \in present : h > c => g <= h
         ELSE CHOOSE g \in present : \A h \in present : g <= h

BatchPick(q, c) ==
    LET g == ChooseGroup(q, c) IN
    CHOOSE i \in 1..Len(q) :
        q[i].group = g /\ \A j \in 1..Len(q) : q[j].group = g => i <= j

RemoveAt(q, i) == SubSeq(q, 1, i - 1) \o SubSeq(q, i + 1, Len(q))

(* Pump: Play > Focus > Batch, non-preemptive. Batch rotates across groups.
   The batch branch snapshots the sync-queue depth for BatchPriorityOk. *)
Pump ==
    /\ busy = FALSE
    /\ \/ /\ Len(queues[1]) > 0
          /\ runTicket' = Head(queues[1])
          /\ busy' = TRUE
          /\ queues' = [queues EXCEPT ![1] = Tail(queues[1])]
          /\ cursor' = cursor
          /\ batchSawBusy' = batchSawBusy
       \/ /\ Len(queues[1]) = 0 /\ Len(queues[2]) > 0
          /\ runTicket' = Head(queues[2])
          /\ busy' = TRUE
          /\ queues' = [queues EXCEPT ![2] = Tail(queues[2])]
          /\ cursor' = cursor
          /\ batchSawBusy' = batchSawBusy
       \/ /\ Len(queues[1]) = 0 /\ Len(queues[2]) = 0 /\ Len(queues[3]) > 0
          /\ LET idx == BatchPick(queues[3], cursor) IN
             /\ runTicket' = queues[3][idx]
             /\ busy' = TRUE
             /\ queues' = [queues EXCEPT ![3] = RemoveAt(queues[3], idx)]
             /\ cursor' = IF runTicket'.group # 0 THEN runTicket'.group ELSE cursor
             /\ batchSawBusy' = Len(queues[1]) + Len(queues[2])
    /\ UNCHANGED tallies

Release ==
    /\ busy = TRUE
    /\ busy' = FALSE
    /\ UNCHANGED <<queues, runTicket, cursor, tallies, batchSawBusy>>

(* Two-phase admission as one atomic step (mirrors the js.mu hold):
   admit iff the fresh tallies stay within both caps, else honest 429.
   Large-model misses count against small (fallback unknowable at intake). *)
SubmitAdmit(nU, nS, nL, nM) ==
    /\ nU \in 0..1 /\ nS \in 0..2 /\ nL \in 0..2 /\ nM \in 0..2
    /\ IF tallies.unfinished + nU > MaxUnfinished
          \/ tallies.sf + nS > MaxMisses
          \/ tallies.large + nL > MaxMisses
          \/ tallies.small + nM > MaxMisses
       THEN UNCHANGED tallies
       ELSE tallies' = [unfinished |-> tallies.unfinished + nU,
                        sf |-> tallies.sf + nS,
                        large |-> tallies.large + nL,
                        small |-> tallies.small + nM]
    /\ UNCHANGED <<queues, busy, runTicket, cursor, batchSawBusy>>

Next ==
    \/ \E p \in SyncPrios, k \in Keys \cup {SampledKey} : EnqueueSync(p, k)
    \/ \E k \in Keys, g \in 1..2 : EnqueueBatch(k, g)
    \/ \E k \in Keys : JoinHit(k)
    \/ Pump
    \/ Release
    \/ \E u \in 0..1, s \in 0..2, l \in 0..2, m \in 0..2 : SubmitAdmit(u, s, l, m)

Spec == Init /\ [][Next]_vars

(* Safety *)
SyncDepthOne == Len(queues[1]) <= 1 /\ Len(queues[2]) <= 1
CapSound ==
    /\ tallies.unfinished <= MaxUnfinished
    /\ tallies.sf <= MaxMisses
    /\ tallies.large <= MaxMisses
    /\ tallies.small <= MaxMisses
BatchPriorityOk == batchSawBusy = 0
Safety == TypeOK /\ SyncDepthOne /\ CapSound /\ BatchPriorityOk

(* TLC run 2026-09-23 (tla2tools 2024-08-08, Temurin JRE 21):
   Keys={"k1","k2"}, MaxMisses=3, MaxUnfinished=2.
   6,789,120 distinct states, depth 14, no errors.
   Deploy note: model SF as two instances (interactive + batch);
   cross-instance dups recompute (evaluate.go:78-80). Maia is one instance. *)
====
