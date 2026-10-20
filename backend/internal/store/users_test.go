package store

import (
	"database/sql"
	"errors"
	"slices"
	"testing"
	"time"
)

func TestUserPrimitive(t *testing.T) {
	store := testStore(t)
	user, err := store.CreateLocalUser("Alice")
	if err != nil || user.ID == "" {
		t.Fatalf("create user: %+v %v", user, err)
	}
	session, err := store.CreateSession(user.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := store.SessionUser(session.ID)
	if err != nil || resolved.ID != user.ID {
		t.Fatalf("session user: %+v %v", resolved, err)
	}
	linked, err := store.UpsertLichessUser("lichess-id-1", "alice_lichess")
	if err != nil {
		t.Fatal(err)
	}
	if linked.LichessUsername != "alice_lichess" {
		t.Fatalf("upsert: %+v", linked)
	}
	if _, err := store.LinkLichess(user.ID, "lichess-id-2", "alice_main"); err != nil {
		t.Fatal(err)
	}
	expired, err := store.CreateSession(user.ID, -time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SessionUser(expired.ID); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("expired session accepted: %v", err)
	}
	if err := store.DeleteSession(session.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SessionUser(session.ID); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("deleted session accepted: %v", err)
	}
}

func TestImportRunsAndSources(t *testing.T) {
	store := testStore(t)
	user, err := store.CreateLocalUser("Carol")
	if err != nil {
		t.Fatal(err)
	}
	payload := gameFixture("src", "e2e4")
	payload.OwnerID = user.ID
	payload.Source = "lichess:zzz99999"
	if _, _, err := store.Save(payload); err != nil {
		t.Fatal(err)
	}
	got, err := store.Get("src")
	if err != nil || got.Source != "lichess:zzz99999" {
		t.Fatalf("source roundtrip: %+v %v", got, err)
	}
	payload.Opponent = "carol-foe"
	if _, _, err := store.Save(payload); err != nil {
		t.Fatal(err)
	}
	got, err = store.Get("src")
	if err != nil || got.Opponent != "carol-foe" {
		t.Fatalf("opponent roundtrip: %+v %v", got, err)
	}
	updated, err := store.UpdateOpponentIfEmpty(user.ID, "lichess:zzz99999", "other")
	if err != nil || updated {
		t.Fatalf("overwrite protection: updated=%t err=%v", updated, err)
	}
	nameless := gameFixture("noname", "e2e4")
	nameless.OwnerID = user.ID
	nameless.Source = "lichess:noname1"
	nameless.Opponent = "temp-name"
	if _, _, err := store.Save(nameless); err != nil {
		t.Fatal(err)
	}
	// Strict schema: opponent is required at write time, so empty saves
	// fail clearly instead of silently storing ''.
	empty := gameFixture("empty-opp", "e2e4")
	empty.OwnerID = user.ID
	empty.Source = "lichess:empty001"
	empty.Opponent = ""
	if _, _, err := store.Save(empty); err == nil {
		t.Fatal("expected empty opponent to fail")
	}
	// Backfill is a no-op safety for already-named rows.
	updated, err = store.UpdateOpponentIfEmpty(user.ID, "lichess:noname1", "found-foe")
	if err != nil || updated {
		t.Fatalf("overwrite protection: updated=%t err=%v", updated, err)
	}
	got, err = store.Get("noname")
	if err != nil || got.Opponent != "temp-name" {
		t.Fatalf("opponent preserved: %+v %v", got, err)
	}
	diff := 9
	updated, err = store.UpdateRatingDiffIfEmpty(user.ID, "lichess:noname1", &diff)
	if err != nil || !updated {
		t.Fatalf("diff backfill: updated=%t err=%v", updated, err)
	}
	got, err = store.Get("noname")
	if err != nil || got.RatingDiff == nil || *got.RatingDiff != 9 {
		t.Fatalf("backfilled diff: %+v %v", got, err)
	}
	other := 3
	updated, err = store.UpdateRatingDiffIfEmpty(user.ID, "lichess:noname1", &other)
	if err != nil || updated {
		t.Fatalf("diff overwrite protection: updated=%t err=%v", updated, err)
	}
	clock, pool := "300+3", "blitz"
	updated, err = store.UpdateTimeControlIfEmpty(user.ID, "lichess:noname1", &clock, &pool)
	if err != nil || !updated {
		t.Fatalf("clock backfill: updated=%t err=%v", updated, err)
	}
	got, err = store.Get("noname")
	if err != nil || got.TimeControl == nil || *got.TimeControl != "300+3" || got.Speed == nil || *got.Speed != "blitz" {
		t.Fatalf("backfilled clock: %+v %v", got, err)
	}
	otherClock, otherPool := "600+0", "rapid"
	updated, err = store.UpdateTimeControlIfEmpty(user.ID, "lichess:noname1", &otherClock, &otherPool)
	if err != nil || updated {
		t.Fatalf("clock overwrite protection: updated=%t err=%v", updated, err)
	}
	updated, err = store.UpdateClocksIfEmpty(user.ID, "lichess:noname1", []int{18000, 17950})
	if err != nil || !updated {
		t.Fatalf("readings backfill: updated=%t err=%v", updated, err)
	}
	got, err = store.Get("noname")
	if err != nil || !slices.Equal(got.Clocks, []int{18000, 17950}) {
		t.Fatalf("backfilled readings: %+v %v", got, err)
	}
	updated, err = store.UpdateClocksIfEmpty(user.ID, "lichess:noname1", []int{17000, 16950})
	if err != nil || updated {
		t.Fatalf("readings overwrite protection: updated=%t err=%v", updated, err)
	}
	known, err := store.ExistingSources(user.ID, []string{"lichess:zzz99999", "lichess:missing"})
	if err != nil || !known["lichess:zzz99999"] || known["lichess:missing"] {
		t.Fatalf("existing sources: %+v %v", known, err)
	}
	run, err := store.RecordImportRun(user.ID, "lichess", "carol", 10, 8, 2)
	if err != nil || run.Saved != 8 {
		t.Fatalf("record run: %+v %v", run, err)
	}
	last, err := store.LastImportRun(user.ID, "lichess")
	if err != nil || last.ID != run.ID || last.Skipped != 2 {
		t.Fatalf("last run: %+v %v", last, err)
	}
	if _, err := store.LastImportRun(user.ID, "other"); err == nil {
		t.Fatal("expected no run for unknown provider")
	}
}

func TestGameOwnership(t *testing.T) {
	store := testStore(t)
	alice, err := store.CreateLocalUser("Alice")
	if err != nil {
		t.Fatal(err)
	}
	bob, err := store.CreateLocalUser("Bob")
	if err != nil {
		t.Fatal(err)
	}
	payload := gameFixture("owned", "e2e4")
	payload.OwnerID = alice.ID
	payload.Current = true
	saved, isNew, err := store.Save(payload)
	if err != nil || !isNew || saved.OwnerID != alice.ID {
		t.Fatalf("save owned: %+v %v", saved, err)
	}
	if id := store.CurrentIDForUser(alice.ID); id != "owned" {
		t.Fatalf("per-user marker = %q", id)
	}
	if id := store.CurrentIDForUser(bob.ID); id != "" {
		t.Fatalf("owned save touched another user's marker: %q", id)
	}
	games, total, err := store.ListForUser(100, alice.ID)
	if err != nil || total != 1 || len(games) != 1 {
		t.Fatalf("alice list: %d %v", total, err)
	}
	games, total, err = store.ListForUser(100, bob.ID)
	if err != nil || total != 0 || len(games) != 0 {
		t.Fatalf("bob list leaks: %d %v", total, err)
	}
	if _, err := store.GetForUser("owned", bob.ID); !errors.Is(err, ErrOwnerMismatch) {
		t.Fatalf("cross-owner read: %v", err)
	}
	clash := gameFixture("owned", "d2d4")
	clash.OwnerID = bob.ID
	if _, _, err := store.Save(clash); !errors.Is(err, ErrOwnerMismatch) {
		t.Fatalf("cross-owner overwrite: %v", err)
	}
	if err := store.DeleteForUser("owned", bob.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get("owned"); err != nil {
		t.Fatalf("cross-owner delete removed row: %v", err)
	}
	if err := store.DeleteForUser("owned", alice.ID); err != nil {
		t.Fatal(err)
	}
	if id := store.CurrentIDForUser(alice.ID); id != "" {
		t.Fatalf("marker survived delete: %q", id)
	}
}
