---- MODULE Repo ----
(*
  Browser game repository (TLA+, TLC-checked).
  Grounding (frontend/src/):
  - document/merge: gameRepository.ts:34-61; mergeSync: serverGames.ts:163-182
    (pending replays over server rows in outbox order; deletes win unless a
    newer save resurrects; highest-ver marked save decides current; dangling
    current -> null)
  - compare-swap persist: gameRepository.ts:82-105 (single Web-Lock,
    expectedRaw check; conflict never overwrites; memory play preserved)
  - save collapse + marker OR: gameRepository.ts:106-116
  - delete announce + hydration cancel, batch never cancelled: 117-133
  - versioned flush/ack: 143-181 (persist-before-transmit; ack removes only
    that version)
  - discard: 137-142 (explicit; no inferred server delete)
  - hydration/epoch/pagination: 182-227 (epoch mismatch -> page neither
    merged nor dropped; null server marker preserves local live game)
  - transport validation: serverGames.ts:65-97

  Epoch is modeled implicitly: concurrent local play during hydration is
    the merge the averted branch; the checked property is that every merge
    outcome still satisfies the safety invariants below.
*)

EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS GameIds, MaxVer, Null

VARIABLES games, currentId, pending, expectedRaw, diskRaw, conflict, epoch, nextVer

vars == <<games, currentId, pending, expectedRaw, diskRaw, conflict, epoch, nextVer>>

TypeOK ==
    /\ \A g \in games : g \in GameIds
    /\ currentId \in GameIds \cup {Null}
    /\ \A i \in 1..Len(pending) :
        /\ pending[i].op \in {"save", "delete"}
        /\ pending[i].gid \in GameIds
        /\ pending[i].ver \in 1..MaxVer
    /\ expectedRaw \in Nat /\ diskRaw \in Nat
    /\ conflict \in {TRUE, FALSE}
    /\ epoch \in Nat /\ nextVer \in 1..(MaxVer + 1)
    /\ Len(pending) <= MaxVer

Init ==
    /\ games = {}
    /\ currentId = Null
    /\ pending = <<>>
    /\ expectedRaw = 0
    /\ diskRaw = 0
    /\ conflict = FALSE
    /\ epoch = 0
    /\ nextVer = 1

(* Local save: epoch++, collapse earlier saves for gid, marker ORs across
   collapsed saves, game surfaces to front. *)
SaveLocal(gid, mc) ==
    /\ gid \in GameIds /\ mc \in {TRUE, FALSE}
    /\ nextVer <= MaxVer
    /\ LET collapsed == SelectSeq(pending, LAMBDA o : ~(o.op = "save" /\ o.gid = gid)) IN
       LET mc2 == mc \/ (\E i \in 1..Len(pending) :
                    pending[i].op = "save" /\ pending[i].gid = gid /\ pending[i].current) IN
       /\ pending' = Append(collapsed, [op |-> "save", gid |-> gid, ver |-> nextVer, current |-> mc2])
       /\ currentId' = IF mc2 THEN gid ELSE currentId
    /\ games' = games \cup {gid}
    /\ epoch' = epoch + 1
    /\ nextVer' = nextVer + 1
    /\ UNCHANGED <<expectedRaw, diskRaw, conflict>>

(* Local delete: epoch++, drop refs, append versioned delete op.
   Batch jobs are untouched (no action here by design). *)
DeleteLocal(gid) ==
    /\ gid \in GameIds
    /\ nextVer <= MaxVer
    /\ games' = games \ {gid}
    /\ currentId' = IF currentId = gid THEN Null ELSE currentId
    /\ pending' = Append(pending, [op |-> "delete", gid |-> gid, ver |-> nextVer])
    /\ epoch' = epoch + 1
    /\ nextVer' = nextVer + 1
    /\ UNCHANGED <<expectedRaw, diskRaw, conflict>>

(* Persist: compare-swap, gated on no conflict (the flush loop returns
   early while conflict is set). Raw revisions are TLC-bounded at 2. *)
PersistOk ==
    /\ conflict = FALSE
    /\ expectedRaw = diskRaw /\ expectedRaw < 2
    /\ expectedRaw' = expectedRaw + 1
    /\ diskRaw' = diskRaw + 1
    /\ UNCHANGED <<games, currentId, pending, conflict, epoch, nextVer>>

PersistConflict ==
    /\ expectedRaw # diskRaw
    /\ conflict' = TRUE
    /\ UNCHANGED <<games, currentId, pending, expectedRaw, diskRaw, epoch, nextVer>>

(* Another tab advances disk (bounded for TLC); this tab goes stale. *)
OtherTabWrite ==
    /\ diskRaw < 2
    /\ diskRaw' = diskRaw + 1
    /\ UNCHANGED <<games, currentId, pending, expectedRaw, conflict, epoch, nextVer>>

(* Flush ack removes ONLY the acked version; newer work survives. The flush
   loop always transmits pending[1] (gameRepository.ts:166), so only the
   head can be acked — out-of-order ack is unrepresentable. *)
AckVersion(v) ==
    /\ v \in 1..MaxVer
    /\ Len(pending) > 0 /\ pending[1].ver = v
    /\ pending' = SelectSeq(pending, LAMBDA o : o.ver # v)
    /\ UNCHANGED <<games, currentId, expectedRaw, diskRaw, conflict, epoch, nextVer>>

(* Explicit recovery: discarding a pending op never infers a server delete.
   All callers pass the failed head version (HistoryRecovery.tsx:31;
   failedVersion is pending[1] on flush failure), so head-only matches every
   real flow; the method's arbitrary-version shape is not exercised. *)
DiscardPending(v) ==
    /\ v \in 1..MaxVer
    /\ Len(pending) > 0 /\ pending[1].ver = v
    /\ pending' = SelectSeq(pending, LAMBDA o : o.ver # v)
    /\ UNCHANGED <<games, currentId, expectedRaw, diskRaw, conflict, epoch, nextVer>>

(* Faithful mergeSync: replay pending in outbox order over server rows. *)

(* Set replay (order-free): g survives iff its newest touching op is a save
   (equivalently: no delete of g is newer than every save of g). *)
KilledByDelete(g, pend) ==
    \E i \in 1..Len(pend) :
        pend[i].op = "delete" /\ pend[i].gid = g /\
        ~(\E j \in 1..Len(pend) :
            pend[j].op = "save" /\ pend[j].gid = g /\ pend[j].ver > pend[i].ver)

(* Marker replay (order-sensitive): saves set it only when marked; deletes
   clear it only when it points at the deleted game. Pending length is
   bounded by MaxVer, so the replay is written out explicitly. *)
ApplyOp(cur, o) ==
    IF o.op = "save" THEN IF o.current THEN o.gid ELSE cur
    ELSE IF cur = o.gid THEN Null ELSE cur

ReplayedCur(serverCur, pend) ==
    IF Len(pend) = 0 THEN serverCur
    ELSE IF Len(pend) = 1 THEN ApplyOp(serverCur, pend[1])
    ELSE IF Len(pend) = 2 THEN ApplyOp(ApplyOp(serverCur, pend[1]), pend[2])
    ELSE IF Len(pend) = 3 THEN ApplyOp(ApplyOp(ApplyOp(serverCur, pend[1]), pend[2]), pend[3])
    ELSE serverCur  (* unreachable: Len(pending) <= MaxVer <= 3 *)

MergeWithServer(serverRows, serverCur) ==
    /\ conflict = FALSE
    /\ serverRows \in SUBSET GameIds
    /\ serverCur \in GameIds \cup {Null}
    /\ LET savedGids == {i \in 1..Len(pending) : pending[i].op = "save"} IN
       LET g == (serverRows \cup {pending[i].gid : i \in savedGids})
                \ {x \in GameIds : KilledByDelete(x, pending)} IN
       LET cur == ReplayedCur(serverCur, pending) IN
       /\ games' = g
       /\ currentId' = IF cur \in g THEN cur ELSE Null
    /\ UNCHANGED <<pending, expectedRaw, diskRaw, conflict, epoch, nextVer>>

Next ==
    \/ \E gid \in GameIds, mc \in {TRUE, FALSE} : SaveLocal(gid, mc)
    \/ \E gid \in GameIds : DeleteLocal(gid)
    \/ PersistOk
    \/ PersistConflict
    \/ OtherTabWrite
    \/ \E v \in 1..MaxVer : AckVersion(v)
    \/ \E v \in 1..MaxVer : DiscardPending(v)
    \/ \E rows \in SUBSET GameIds, cur \in GameIds \cup {Null} : MergeWithServer(rows, cur)

Spec == Init /\ [][Next]_vars

(* Safety: pending-wins in both directions, marker validity. Each holds
   after local ops (which update games+pending together), after merges
   (by construction), and after ack/discard (fewer constraints). *)
SaveVisible ==
    \A i \in 1..Len(pending) : pending[i].op = "save" =>
        pending[i].gid \in games \/
        (\E j \in 1..Len(pending) : pending[j].op = "delete" /\
            pending[j].gid = pending[i].gid /\ pending[j].ver > pending[i].ver)
DeleteWins ==
    \A i \in 1..Len(pending) : pending[i].op = "delete" =>
        pending[i].gid \notin games \/
        (\E j \in 1..Len(pending) : pending[j].op = "save" /\
            pending[j].gid = pending[i].gid /\ pending[j].ver > pending[i].ver)
OrphanNull == currentId = Null \/ currentId \in games
VersionsUnique ==
    \A i, j \in 1..Len(pending) : i # j => pending[i].ver # pending[j].ver
Safety == TypeOK /\ SaveVisible /\ DeleteWins /\ OrphanNull /\ VersionsUnique

(* TLC run 2026-09-23: GameIds={"g1","g2"}, MaxVer=3.
   3,312 distinct states, depth 9, no errors, full coverage. *)
====
