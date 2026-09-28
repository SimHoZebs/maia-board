package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func testStore(t *testing.T) *GameStore {
	t.Helper()
	store, err := NewGameStore(filepath.Join(t.TempDir(), "games.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return store
}

// Every pooled connection must inherit WAL + busy-timeout + foreign-keys
// from the DSN: with MaxOpenConns > 1 an Exec-only setup would leave later
// connections on defaults and invite database-is-locked bursts.
func TestGameStoreDSNPragmas(t *testing.T) {
	store := testStore(t)
	ctx := context.Background()
	first, err := store.db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := store.db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	for i, conn := range []interface {
		QueryRowContext(context.Context, string, ...any) *sql.Row
	}{first, second} {
		var journal string
		if err := conn.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&journal); err != nil || journal != "wal" {
			t.Fatalf("conn %d journal_mode=%q err=%v", i, journal, err)
		}
		var timeout int
		if err := conn.QueryRowContext(ctx, "PRAGMA busy_timeout").Scan(&timeout); err != nil || timeout != 5000 {
			t.Fatalf("conn %d busy_timeout=%d err=%v", i, timeout, err)
		}
		var fk int
		if err := conn.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&fk); err != nil || fk != 1 {
			t.Fatalf("conn %d foreign_keys=%d err=%v", i, fk, err)
		}
	}
}

func gameFixture(id string, moves ...string) GamePayload {
	maia, user := 1600, 1400
	return GamePayload{ID: id, UserColor: "white", EloMaia: &maia, EloUser: &user, Model: "79m", Moves: moves}
}

func TestGameStoreSaveGetList(t *testing.T) {
	store := testStore(t)
	first, err := store.Save(gameFixture("a", "e2e4"))
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != "a" || first.CreatedAt == "" || first.UpdatedAt == "" {
		t.Fatalf("unexpected saved row: %+v", first)
	}
	if _, err := store.Save(gameFixture("b", "e2e4", "e7e5")); err != nil {
		t.Fatal(err)
	}
	games, total, err := store.List(200)
	if err != nil || total != 2 || len(games) != 2 {
		t.Fatalf("list = %d/%d, err = %v", len(games), total, err)
	}
	if games[0].ID != "b" {
		t.Fatalf("expected most-recent first, got %+v", games)
	}
	got, err := store.Get("a")
	if err != nil || len(got.Moves) != 1 || got.Moves[0] != "e2e4" {
		t.Fatalf("get = %+v, err = %v", got, err)
	}
	if _, err := store.Get("missing"); err == nil {
		t.Fatal("expected missing game error")
	}
}

func TestGameStoreUpsertPreservesCreatedAt(t *testing.T) {
	store := testStore(t)
	saved, err := store.Save(gameFixture("a", "e2e4"))
	if err != nil {
		t.Fatal(err)
	}
	updated := gameFixture("a", "e2e4", "e7e5")
	updated.CreatedAt = "2000-01-01T00:00:00Z"
	resaved, err := store.Save(updated)
	if err != nil {
		t.Fatal(err)
	}
	if resaved.CreatedAt != saved.CreatedAt {
		t.Fatalf("created_at changed: %q -> %q", saved.CreatedAt, resaved.CreatedAt)
	}
	if len(resaved.Moves) != 2 {
		t.Fatalf("moves not updated: %+v", resaved)
	}
}

func TestGameStoreUnchangedSavePreservesOrder(t *testing.T) {
	store := testStore(t)
	if _, err := store.Save(gameFixture("a", "e2e4")); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Save(gameFixture("b", "d2d4")); err != nil {
		t.Fatal(err)
	}
	unchanged := gameFixture("a", "e2e4")
	unchanged.Current = true
	resaved, err := store.Save(unchanged)
	if err != nil {
		t.Fatal(err)
	}
	games, _, err := store.List(200)
	if err != nil {
		t.Fatal(err)
	}
	if len(games) != 2 || games[0].ID != "b" || games[1].ID != "a" {
		t.Fatalf("resave reshuffled recency: %+v", games)
	}
	if resaved.UpdatedAt != games[1].UpdatedAt {
		t.Fatalf("resave rewrote timestamp: %+v", resaved)
	}
	if id := store.CurrentID(); id != "a" {
		t.Fatalf("marker not set on unchanged save: %q", id)
	}
	changed := gameFixture("a", "e2e4", "e7e5")
	if _, err := store.Save(changed); err != nil {
		t.Fatal(err)
	}
	games, _, err = store.List(200)
	if err != nil {
		t.Fatal(err)
	}
	if games[0].ID != "a" {
		t.Fatalf("changed save did not surface: %+v", games)
	}
}

// An orphan current-game marker must read as no current game, never as a
// dangling id paired with a null row.

func TestGameStoreResult(t *testing.T) {
	store := testStore(t)
	payload := gameFixture("a", "e2e4")
	payload.Result = "resigned"
	saved, err := store.Save(payload)
	if err != nil || saved.Result != "resigned" {
		t.Fatalf("saved = %+v, err = %v", saved, err)
	}
	got, err := store.Get("a")
	if err != nil || got.Result != "resigned" {
		t.Fatalf("get = %+v, err = %v", got, err)
	}
	bad := gameFixture("b", "e2e4")
	bad.Result = "maia-wins"
	if err := ValidateGamePayload(&bad); err == nil || err.Code != "invalid_result" {
		t.Fatalf("expected invalid_result, got %v", err)
	}
}

func TestGameStoreCurrentMarker(t *testing.T) {
	store := testStore(t)
	if id := store.CurrentID(); id != "" {
		t.Fatalf("expected empty marker, got %q", id)
	}
	payload := gameFixture("a")
	payload.Current = true
	if _, err := store.Save(payload); err != nil {
		t.Fatal(err)
	}
	if id := store.CurrentID(); id != "a" {
		t.Fatalf("marker = %q", id)
	}
	if _, err := store.Save(gameFixture("b")); err != nil {
		t.Fatal(err)
	}
	if id := store.CurrentID(); id != "a" {
		t.Fatalf("plain save moved marker to %q", id)
	}
	if err := store.Delete("a"); err != nil {
		t.Fatal(err)
	}
	if id := store.CurrentID(); id != "" {
		t.Fatalf("delete did not clear marker: %q", id)
	}
	if err := store.Delete("missing"); err != nil {
		t.Fatalf("delete of unknown id must succeed: %v", err)
	}
}
