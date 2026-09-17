package main

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"testing"
)

func TestTemperatureJSONHelper(t *testing.T) {
	if os.Getenv("MAIA_TEMP_HELPER") != "1" {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	index := 0
	fmt.Println(`{"ready":true}`)
	for scanner.Scan() {
		var request EngineRequest
		if json.Unmarshal(scanner.Bytes(), &request) != nil || index >= 2 || request.Temperature != []float64{.7, 0}[index] {
			os.Exit(2)
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"result": engineFixture("e2e4"), "legal_count": 1})
		index++
	}
	os.Exit(0)
}

func TestWorkerResetsTemperatureForEachRequest(t *testing.T) {
	t.Setenv("MAIA_TEMP_HELPER", "1")
	worker := NewWorker("test", []string{os.Args[0], "-test.run=^TestTemperatureJSONHelper$"})
	defer worker.close()
	for _, temperature := range []float64{.7, 0} {
		_, release, err := worker.predict(context.Background(), context.Background(), PriorityFocus, 0, EngineRequest{FEN: startFEN, SelfElo: 1600, OppoElo: 1600, Temperature: temperature})
		if release != nil {
			release()
		}
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestEngineSettingsValidation(t *testing.T) {
	for _, value := range []float64{-1, 2.1, math.NaN(), math.Inf(1)} {
		if validTemperature(value) {
			t.Fatalf("accepted temperature %v", value)
		}
	}
	elo := 1600
	for _, value := range []float64{0, .7, 2} {
		request, _, err := validateMoveRequest(moveRequest{FEN: startFEN, EloMaia: &elo, EloUser: &elo, MaiaColor: "white", Temperature: value})
		if err != nil || request.Temperature != value {
			t.Fatalf("temperature mapping: %+v %v", request, err)
		}
	}
	for _, settings := range []stockfishSettings{{249, 2, 0}, {30001, 2, 0}, {750, 0, 0}, {750, 6, 0}, {750, 2, -1}, {750, 2, 41}} {
		if validateEvaluationRequest(&evaluationRequest{FEN: startFEN, Settings: &settings}) == nil {
			t.Fatalf("accepted %+v", settings)
		}
	}
	settings := &stockfishSettings{750, 2, 0}
	if settings.policy() != "sf19-ms750-mpv2-d0-t4-h128-v3" {
		t.Fatal(settings.policy())
	}
	settings = &stockfishSettings{30000, 5, 40}
	if settings.validate() != nil || settings.policy() != "sf19-ms30000-mpv5-d40-t4-h128-v3" {
		t.Fatal(settings.policy())
	}
	if (*stockfishSettings)(nil).policy() != SearchPolicy {
		t.Fatal("legacy policy changed")
	}
}

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
	payload := gamePayload{ID: "new", UserColor: "white", EloMaia: &elo, EloUser: &elo, Model: "79m", Moves: []string{}, Temperature: .7}
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
	resigned := gamePayload{ID: "old", UserColor: "white", EloMaia: &elo, EloUser: &elo, Model: "79m", Moves: []string{"e2e4"}, Result: "resigned"}
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

func TestSampledMoveMayDifferFromPolicyCandidates(t *testing.T) {
	for _, sampled := range []string{"d2d4", "a2a3"} {
		result := engineFixture("e2e4")
		result.Move = sampled
		if !validEngineResult(result, 1, false) || result.Candidates[0].Move != "e2e4" {
			t.Fatalf("sampled result: %+v", result)
		}
	}
}
