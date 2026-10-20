package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"slices"
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
	return GamePayload{ID: id, UserColor: "white", EloMaia: &maia, EloUser: &user, Model: "79m", Moves: moves, Source: "local", Opponent: "Maia 1600"}
}

func TestGameStoreSaveGetList(t *testing.T) {
	store := testStore(t)
	first, _, err := store.Save(gameFixture("a", "e2e4"))
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != "a" || first.CreatedAt == "" || first.UpdatedAt == "" {
		t.Fatalf("unexpected saved row: %+v", first)
	}
	if _, _, err := store.Save(gameFixture("b", "e2e4", "e7e5")); err != nil {
		t.Fatal(err)
	}
	games, total, err := store.ListForUser(200, "")
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
	saved, isNew, err := store.Save(gameFixture("a", "e2e4"))
	if err != nil {
		t.Fatal(err)
	}
	if !isNew {
		t.Fatal("first save must report isNew=true")
	}
	updated := gameFixture("a", "e2e4", "e7e5")
	updated.CreatedAt = "2000-01-01T00:00:00Z"
	resaved, isNew, err := store.Save(updated)
	if err != nil {
		t.Fatal(err)
	}
	if isNew {
		t.Fatal("update save must report isNew=false")
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
	if _, _, err := store.Save(gameFixture("a", "e2e4")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Save(gameFixture("b", "d2d4")); err != nil {
		t.Fatal(err)
	}
	unchanged := gameFixture("a", "e2e4")
	unchanged.Current = true
	resaved, _, err := store.Save(unchanged)
	if err != nil {
		t.Fatal(err)
	}
	games, _, err := store.ListForUser(200, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(games) != 2 || games[0].ID != "b" || games[1].ID != "a" {
		t.Fatalf("resave reshuffled recency: %+v", games)
	}
	if resaved.UpdatedAt != games[1].UpdatedAt {
		t.Fatalf("resave rewrote timestamp: %+v", resaved)
	}
	if id := store.CurrentIDForUser(""); id != "" {
		t.Fatalf("unscoped save tracked a marker: %q", id)
	}
	changed := gameFixture("a", "e2e4", "e7e5")
	if _, _, err := store.Save(changed); err != nil {
		t.Fatal(err)
	}
	games, _, err = store.ListForUser(200, "")
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
	saved, _, err := store.Save(payload)
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

func TestGameStoreRatingDiff(t *testing.T) {
	store := testStore(t)
	payload := gameFixture("diff", "e2e4")
	diff := 12
	payload.RatingDiff = &diff
	saved, _, err := store.Save(payload)
	if err != nil || saved.RatingDiff == nil || *saved.RatingDiff != 12 {
		t.Fatalf("saved = %+v, err = %v", saved, err)
	}
	got, err := store.Get("diff")
	if err != nil || got.RatingDiff == nil || *got.RatingDiff != 12 {
		t.Fatalf("get = %+v, err = %v", got, err)
	}
	// Unchanged re-save must not churn recency when the diff matches.
	again, _, err := store.Save(payload)
	if err != nil || again.UpdatedAt != saved.UpdatedAt {
		t.Fatalf("unchanged diff churned recency: %+v", again)
	}
	// Nil and zero are distinct: zero is a real diff, nil is unknown.
	zero := 0
	zeroPayload := gameFixture("zero", "e2e4")
	zeroPayload.RatingDiff = &zero
	if _, _, err := store.Save(zeroPayload); err != nil {
		t.Fatal(err)
	}
	gotZero, err := store.Get("zero")
	if err != nil || gotZero.RatingDiff == nil || *gotZero.RatingDiff != 0 {
		t.Fatalf("zero diff lost: %+v %v", gotZero, err)
	}
	plain, _, err := store.Save(gameFixture("plain", "e2e4"))
	if err != nil || plain.RatingDiff != nil {
		t.Fatalf("expected nil diff, got %+v", plain)
	}
	bad := gameFixture("bad", "e2e4")
	out := 5000
	bad.RatingDiff = &out
	if err := ValidateGamePayload(&bad); err == nil || err.Code != "invalid_rating_diff" {
		t.Fatalf("expected invalid_rating_diff, got %v", err)
	}
}

func TestGameStoreTimeControl(t *testing.T) {
	store := testStore(t)
	payload := gameFixture("clock", "e2e4")
	clock, speed := "600+5", "rapid"
	payload.TimeControl = &clock
	payload.Speed = &speed
	saved, _, err := store.Save(payload)
	if err != nil || saved.TimeControl == nil || *saved.TimeControl != "600+5" || saved.Speed == nil || *saved.Speed != "rapid" {
		t.Fatalf("saved = %+v, err = %v", saved, err)
	}
	got, err := store.Get("clock")
	if err != nil || got.TimeControl == nil || *got.TimeControl != "600+5" || got.Speed == nil || *got.Speed != "rapid" {
		t.Fatalf("get = %+v, err = %v", got, err)
	}
	// Unchanged re-save must not churn recency when the clock matches.
	again, _, err := store.Save(payload)
	if err != nil || again.UpdatedAt != saved.UpdatedAt {
		t.Fatalf("unchanged clock churned recency: %+v", again)
	}
	plain, _, err := store.Save(gameFixture("plain", "e2e4"))
	if err != nil || plain.TimeControl != nil || plain.Speed != nil {
		t.Fatalf("expected nil clock, got %+v", plain)
	}
	for _, raw := range []string{"10+0", "180+2", "3d", "-"} {
		valid := gameFixture("ok-"+raw, "e2e4")
		value := raw
		valid.TimeControl = &value
		if err := ValidateGamePayload(&valid); err != nil {
			t.Fatalf("valid clock %q rejected: %v", raw, err)
		}
	}
	for _, raw := range []string{"10", "+", "1/86400", "15d", "600+99999", ""} {
		invalid := gameFixture("bad-clock", "e2e4")
		value := raw
		invalid.TimeControl = &value
		if err := ValidateGamePayload(&invalid); err == nil || err.Code != "invalid_time_control" {
			t.Fatalf("clock %q: expected invalid_time_control, got %v", raw, err)
		}
	}
	badSpeed := gameFixture("bad-speed", "e2e4")
	pool := "hyperbullet"
	badSpeed.Speed = &pool
	if err := ValidateGamePayload(&badSpeed); err == nil || err.Code != "invalid_speed" {
		t.Fatalf("expected invalid_speed, got %v", err)
	}
}

func TestGameStoreClocks(t *testing.T) {
	store := testStore(t)
	payload := gameFixture("timed", "e2e4", "e7e5")
	payload.Clocks = []int{18000, 17950}
	saved, _, err := store.Save(payload)
	if err != nil || !slices.Equal(saved.Clocks, []int{18000, 17950}) {
		t.Fatalf("saved = %+v, err = %v", saved, err)
	}
	got, err := store.Get("timed")
	if err != nil || !slices.Equal(got.Clocks, []int{18000, 17950}) {
		t.Fatalf("get = %+v, %v", got, err)
	}
	// Unchanged re-save must not churn recency when the readings match.
	again, _, err := store.Save(payload)
	if err != nil || again.UpdatedAt != saved.UpdatedAt {
		t.Fatalf("unchanged clocks churned recency: %+v", again)
	}
	plain, _, err := store.Save(gameFixture("plain", "e2e4"))
	if err != nil || plain.Clocks != nil {
		t.Fatalf("expected nil clocks, got %+v", plain)
	}
	short := gameFixture("short", "e2e4", "e7e5")
	short.Clocks = []int{18000}
	if err := ValidateGamePayload(&short); err == nil || err.Code != "invalid_clocks" {
		t.Fatalf("length mismatch: expected invalid_clocks, got %v", err)
	}
	negative := gameFixture("negative", "e2e4")
	negative.Clocks = []int{-5}
	if err := ValidateGamePayload(&negative); err == nil || err.Code != "invalid_clocks" {
		t.Fatalf("negative reading: expected invalid_clocks, got %v", err)
	}
	huge := gameFixture("huge", "e2e4")
	huge.Clocks = []int{14*86400*100 + 1}
	if err := ValidateGamePayload(&huge); err == nil || err.Code != "invalid_clocks" {
		t.Fatalf("oversize reading: expected invalid_clocks, got %v", err)
	}
}

func TestGameStoreCurrentMarker(t *testing.T) {
	store := testStore(t)
	user, err := store.CreateLocalUser("Player")
	if err != nil {
		t.Fatal(err)
	}
	owned := func(id string, current bool) GamePayload {
		payload := gameFixture(id)
		payload.OwnerID = user.ID
		payload.Current = current
		return payload
	}
	if id := store.CurrentIDForUser(user.ID); id != "" {
		t.Fatalf("expected empty marker, got %q", id)
	}
	if _, _, err := store.Save(owned("a", true)); err != nil {
		t.Fatal(err)
	}
	if id := store.CurrentIDForUser(user.ID); id != "a" {
		t.Fatalf("marker = %q", id)
	}
	if _, _, err := store.Save(owned("b", false)); err != nil {
		t.Fatal(err)
	}
	if id := store.CurrentIDForUser(user.ID); id != "a" {
		t.Fatalf("plain save moved marker to %q", id)
	}
	if err := store.DeleteForUser("a", user.ID); err != nil {
		t.Fatal(err)
	}
	if id := store.CurrentIDForUser(user.ID); id != "" {
		t.Fatalf("delete did not clear marker: %q", id)
	}
	if err := store.DeleteForUser("missing", user.ID); err != nil {
		t.Fatalf("delete of unknown id must succeed: %v", err)
	}
}
