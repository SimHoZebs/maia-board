package store

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

func TestTemperatureMigrationAndRoundtrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "games.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE games (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, user_color TEXT NOT NULL, elo_maia INTEGER NOT NULL, elo_user INTEGER NOT NULL, model TEXT NOT NULL, moves TEXT NOT NULL);
	INSERT INTO games VALUES ('old', '2026-09-11T00:00:00Z', '2026-09-11T00:00:00Z', 'white', 1600, 1600, '79m', '[]')`)
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	store, err := NewGameStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	if err := migrateGameSchema(store.db); err != nil {
		t.Fatal(err)
	}
	old, err := store.Get("old")
	if err != nil || old.Temperature != 0 || old.Result != "" || old.RatingDiff != nil {
		t.Fatalf("old game: %+v %v", old, err)
	}
	if old.Source != "local" || old.Opponent != "Maia 1600" {
		t.Fatalf("legacy backfill: %+v", old)
	}
	elo := 1600
	payload := GamePayload{ID: "new", UserColor: "white", EloMaia: &elo, EloUser: &elo, Model: "79m", Moves: []string{}, Temperature: .7, Source: "local", Opponent: "Maia 1600"}
	saved, _, err := store.Save(payload)
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := store.Get(saved.ID)
	if err != nil || loaded.Temperature != .7 {
		t.Fatalf("roundtrip: %+v %v", loaded, err)
	}
	again, _, err := store.Save(payload)
	if err != nil || again.UpdatedAt != saved.UpdatedAt {
		t.Fatal("unchanged save changed recency", err)
	}
	resigned := GamePayload{ID: "old", UserColor: "white", EloMaia: &elo, EloUser: &elo, Model: "79m", Moves: []string{"e2e4"}, Result: "resigned", Source: "local", Opponent: "Maia 1600"}
	if _, _, err := store.Save(resigned); err != nil {
		t.Fatal(err)
	}
	got, err := store.Get("old")
	if err != nil || got.Result != "resigned" || len(got.Moves) != 1 {
		t.Fatalf("resigned roundtrip: %+v %v", got, err)
	}
	rows, _, err := store.List(10)
	if err != nil || len(rows) != 2 {
		t.Fatal("list after migration", err)
	}
}

// Regression for the prod crash loop (07ba03e): pre-strict DBs carry the
// old `WHERE source <> ”` unique index under the same name. CREATE IF NOT
// EXISTS kept the stale predicate live, so backfilling N empty-source rows
// for one owner to `local` collided on row 2 and NewGameStore failed open.
// The fix drops the index before recreating it with `LIKE 'lichess:%'`.
func TestStaleOwnerSourceIndexDoesNotBlockLocalBackfill(t *testing.T) {
	path := filepath.Join(t.TempDir(), "games.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE games (
		id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
		user_color TEXT NOT NULL, elo_maia INTEGER NOT NULL, elo_user INTEGER NOT NULL,
		model TEXT NOT NULL, moves TEXT NOT NULL,
		owner_id TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', opponent TEXT NOT NULL DEFAULT '');
	CREATE UNIQUE INDEX idx_games_owner_source ON games(owner_id, source) WHERE source <> '';
	INSERT INTO games (id, created_at, updated_at, user_color, elo_maia, elo_user, model, moves, owner_id, source, opponent) VALUES
		('g1', '2026-09-11T00:00:00Z', '2026-09-11T00:00:00Z', 'white', 1600, 1600, '79m', '[]', 'owner1', '', ''),
		('g2', '2026-09-11T00:00:00Z', '2026-09-11T00:00:00Z', 'white', 1500, 1500, '79m', '[]', 'owner1', '', ''),
		('g3', '2026-09-11T00:00:00Z', '2026-09-11T00:00:00Z', 'black', 1400, 1400, '79m', '[]', 'owner1', '', '')`)
	if err != nil {
		db.Close()
		t.Fatal(err)
	}
	db.Close()
	store, err := NewGameStore(path)
	if err != nil {
		t.Fatalf("open with stale index: %v", err)
	}
	defer store.db.Close()
	for _, id := range []string{"g1", "g2", "g3"} {
		got, err := store.Get(id)
		if err != nil {
			t.Fatal(err)
		}
		if got.Source != "local" {
			t.Fatalf("row %s source = %q, want local", id, got.Source)
		}
		if got.Opponent == "" {
			t.Fatalf("row %s opponent still empty", id)
		}
	}
	var indexSQL string
	if err := store.db.QueryRow(`SELECT sql FROM sqlite_master WHERE name = 'idx_games_owner_source'`).Scan(&indexSQL); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(indexSQL, "lichess") {
		t.Fatalf("stale index predicate kept: %s", indexSQL)
	}
}
