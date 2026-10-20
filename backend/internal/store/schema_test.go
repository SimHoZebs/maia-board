package store

import (
	"path/filepath"
	"testing"
)

func TestGameSchemaRoundtrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "games.db")
	store, err := NewGameStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
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
	rows, _, err := store.ListForUser(10, "")
	if err != nil || len(rows) != 2 {
		t.Fatalf("list after save: %v", err)
	}
}
