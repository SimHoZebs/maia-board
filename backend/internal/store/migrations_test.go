package store

import (
	"database/sql"
	"path/filepath"
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
	if err != nil || old.Temperature != 0 || old.Result != "" {
		t.Fatalf("old game: %+v %v", old, err)
	}
	elo := 1600
	payload := GamePayload{ID: "new", UserColor: "white", EloMaia: &elo, EloUser: &elo, Model: "79m", Moves: []string{}, Temperature: .7}
	saved, err := store.Save(payload)
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := store.Get(saved.ID)
	if err != nil || loaded.Temperature != .7 {
		t.Fatalf("roundtrip: %+v %v", loaded, err)
	}
	again, err := store.Save(payload)
	if err != nil || again.UpdatedAt != saved.UpdatedAt {
		t.Fatal("unchanged save changed recency", err)
	}
	resigned := GamePayload{ID: "old", UserColor: "white", EloMaia: &elo, EloUser: &elo, Model: "79m", Moves: []string{"e2e4"}, Result: "resigned"}
	if _, err := store.Save(resigned); err != nil {
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
