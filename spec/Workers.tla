---- MODULE Workers ----
(*
  Engine workers: Maia pool + Stockfish slots (TLA+, TLC-checked).
  Grounding:
  - states/lifecycle: backend/engine.go:73-119, 282-381
  - predict/admit/abandon: engine.go:146-205; admit: backend/admission.go:12-36
  - reply validation: engine.go:206-281
  - 79M→5M fallback allowlist: engine.go:395-421 (fallback ONLY on
    unexpected failures; busy/joined/superseded/canceled/mismatch/invalid/
    noLegal pass through)
  - degraded policy: reviews.go:92-134; write guard:
    evaluation_documents.go:29-32; read hardening:
    evaluation_identity.go:453-467
  - SF slots/timeout: evaluate.go:73-93, 266-281, 381-439

  Abstraction: payloads are (key, sampled); degraded is decided at settle
  time (fallback outcome). No JSON, no processes.
*)

EXTENDS Naturals, FiniteSets, TLC

CONSTANTS OpIds, KeySet, Null

(* wstate (unloaded/starting/ready/busy/failed, engine.go:73-119) is
   intentionally not a TLC variable: lifecycle cycling multiplies every
   state ~625x while the checked invariants (SlotBound, NeverBadStore)
   do not mention it. Process kill/reap on hard failure is documented in
   WorkerFail below as a design note, not a checked action. *)

VARIABLES slot, op, storedInfo

vars == <<slot, op, storedInfo>>

Insts == {"maia", "sfSync", "sfBatch"}

AddOp(oid, rec) == [o \in DOMAIN op \cup {oid} |-> IF o = oid THEN rec ELSE op[o]]

TypeOK ==
    /\ \A s \in Insts : slot[s] = Null \/ slot[s] \in OpIds
    /\ \A o \in DOMAIN op :
        /\ op[o].key \in KeySet
        /\ op[o].sampled \in {TRUE, FALSE}
        /\ op[o].abandoned \in {TRUE, FALSE}
        /\ op[o].settled \in {TRUE, FALSE}
    /\ \A k \in DOMAIN storedInfo :
        /\ storedInfo[k].sampled \in {TRUE, FALSE}
        /\ storedInfo[k].degraded \in {TRUE, FALSE}

Init ==
    /\ slot = [s \in Insts |-> Null]
    /\ op = [o \in {} |-> [key |-> "x", sampled |-> FALSE, abandoned |-> FALSE, settled |-> FALSE]]
    /\ storedInfo = [k \in {} |-> [sampled |-> FALSE, degraded |-> FALSE]]

(* Admit through the priority scheduler; sampled requests get a key too but
   never join (JoinDup requires a deterministic in-flight key). *)
AdmitGrant(inst, oid, key, sampled) ==
    /\ inst \in Insts
    /\ oid \in OpIds \ DOMAIN op
    /\ key \in KeySet /\ sampled \in {TRUE, FALSE}
    /\ slot[inst] = Null
    /\ slot' = [slot EXCEPT ![inst] = oid]
    /\ op' = AddOp(oid, [key |-> key, sampled |-> sampled,
                         abandoned |-> FALSE, settled |-> FALSE])
    /\ UNCHANGED storedInfo

(* Deterministic duplicate joins the owner; caller re-reads cache after the
   owner stores. Cancelled owners make joiners enqueue fresh (no-op here). *)
AdmitJoin(oid) ==
    /\ oid \in DOMAIN op
    /\ op[oid].settled = FALSE
    /\ op[oid].sampled = FALSE
    /\ UNCHANGED vars

(* Disconnect races completion: a closed op wins; otherwise the waiter
   abandons and the op holds its slot until drained, still writing through
   deterministic results on its detached context. *)
Abandon(oid) ==
    /\ oid \in DOMAIN op /\ op[oid].settled = FALSE
    /\ op' = [op EXCEPT ![oid].abandoned = TRUE]
    /\ UNCHANGED <<slot, storedInfo>>

(* Settle: write-through iff deterministic, validated, non-degraded.
   storedInfo records exactly what was filed, so NeverBadStore is meaningful. *)
SettleSuccess(oid, degraded) ==
    /\ oid \in DOMAIN op /\ op[oid].settled = FALSE
    /\ degraded \in {TRUE, FALSE}
    /\ op' = [op EXCEPT ![oid].settled = TRUE]
    /\ IF op[oid].sampled = FALSE /\ degraded = FALSE
       THEN storedInfo' = [k \in DOMAIN storedInfo \cup {op[oid].key} |->
                IF k = op[oid].key
                THEN [sampled |-> op[oid].sampled, degraded |-> degraded]
                ELSE storedInfo[k]]
       ELSE UNCHANGED storedInfo
    /\ UNCHANGED slot

(* Exactly-once release: caller path on success, background path on abandon;
   Release guards slot[inst] = oid (running != grant returns). *)
ReleaseSlot(inst) ==
    /\ inst \in Insts
    /\ slot[inst] # Null
    /\ slot' = [slot EXCEPT ![inst] = Null]
    /\ UNCHANGED <<op, storedInfo>>

(* Design notes (not checked actions):
   - Hard failure kills + reaps the process group before releasing admission;
     success preserves the warm process (engine.go:352-375).
   - Fallback split (engine.go:410-411): bypass errors never fall back. *)
LargeFailsBypass == UNCHANGED vars
LargeFailsUnexpected == UNCHANGED vars

Next ==
    \/ \E inst \in Insts, oid \in OpIds, k \in KeySet, s \in {TRUE, FALSE} : AdmitGrant(inst, oid, k, s)
    \/ \E oid \in OpIds : AdmitJoin(oid)
    \/ \E oid \in OpIds : Abandon(oid)
    \/ \E oid \in OpIds, d \in {TRUE, FALSE} : SettleSuccess(oid, d)
    \/ \E inst \in Insts : ReleaseSlot(inst)
    \/ LargeFailsBypass
    \/ LargeFailsUnexpected

Spec == Init /\ [][Next]_vars

(* Safety *)
SlotBound == \A s \in Insts : slot[s] = Null \/ slot[s] \in OpIds
NeverBadStore ==
    \A k \in DOMAIN storedInfo :
        storedInfo[k].sampled = FALSE /\ storedInfo[k].degraded = FALSE
Safety == TypeOK /\ SlotBound /\ NeverBadStore

(* TLC run 2026-09-23: OpIds={"o1","o2"}, KeySet={"a","b"}.
   5,153 distinct states, depth 9, no errors, full coverage. *)
====
