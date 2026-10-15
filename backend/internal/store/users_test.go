package store

import (
	"database/sql"
	"errors"
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

func TestAdoptLegacyGames(t *testing.T) {
	store := testStore(t)
	if _, _, err := store.Save(gameFixture("legacy", "e2e4")); err != nil {
		t.Fatal(err)
	}
	marker := gameFixture("current", "d2d4")
	marker.Current = true
	if _, _, err := store.Save(marker); err != nil {
		t.Fatal(err)
	}
	alice, err := store.CreateLocalUser("Alice")
	if err != nil {
		t.Fatal(err)
	}
	adopted, err := store.AdoptLegacyGames(alice.ID)
	if err != nil || adopted != 2 {
		t.Fatalf("adopted=%d err=%v", adopted, err)
	}
	if _, err := store.GetForUser("legacy", alice.ID); err != nil {
		t.Fatalf("adopted row unreadable: %v", err)
	}
	if id := store.CurrentIDForUser(alice.ID); id != "current" {
		t.Fatalf("marker not carried: %q", id)
	}
	if unowned, err := store.CountUnowned(); err != nil || unowned != 0 {
		t.Fatalf("unowned=%d err=%v", unowned, err)
	}
	bob, err := store.CreateLocalUser("Bob")
	if err != nil {
		t.Fatal(err)
	}
	adopted, err = store.AdoptLegacyGames(bob.ID)
	if err != nil || adopted != 0 {
		t.Fatalf("second adopt=%d err=%v", adopted, err)
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
	if id := store.CurrentID(); id != "" {
		t.Fatalf("legacy marker polluted: %q", id)
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
