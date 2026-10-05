package server

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"maia-board/backend/internal/store"
)

func testStore(t *testing.T) *store.GameStore {
	t.Helper()
	gameStore, err := store.NewGameStore(filepath.Join(t.TempDir(), "games.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { gameStore.Close() })
	return gameStore
}

// normalizeJSON re-encodes so semantically identical documents compare equal
// regardless of key order (hits serve the stored document verbatim while
// misses serialize fresh structs).
func normalizeJSON(t *testing.T, document string) string {
	t.Helper()
	var value any
	if err := json.Unmarshal([]byte(document), &value); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("cannot re-encode JSON: %v", err)
	}
	return string(encoded)
}

func gameFixture(id string, moves ...string) store.GamePayload {
	maia, user := 1600, 1400
	return store.GamePayload{ID: id, UserColor: "white", EloMaia: &maia, EloUser: &user, Model: "79m", Moves: moves}
}
func TestGamesPersistenceBudget(t *testing.T) {
	s := &Server{store: testStore(t)}
	for _, count := range []int{257, 4096, 4097} {
		moves := make([]string, count)
		for i := range moves {
			moves[i] = "e2e4"
		}
		payload := gameFixture("large", moves...)
		body, _ := json.Marshal(payload)
		w := httptest.NewRecorder()
		s.games(w, httptest.NewRequest("POST", "/games", strings.NewReader(string(body))))
		expected := 200
		if count > 4096 {
			expected = 400
		}
		if w.Code != expected {
			t.Fatalf("%d plies: status %d, body %s", count, w.Code, w.Body)
		}
	}
	oversized := gameFixture(strings.Repeat("a", 64*1024), "e2e4")
	body, _ := json.Marshal(oversized)
	w := httptest.NewRecorder()
	s.games(w, httptest.NewRequest("POST", "/games", strings.NewReader(string(body))))
	if w.Code != 400 {
		t.Fatalf("oversized body status %d", w.Code)
	}
}
func TestGamesPagesIncludeCurrentOutsidePage(t *testing.T) {
	gameStore := testStore(t)
	current := gameFixture("old", "e2e4")
	current.Current = true
	if _, _, err := gameStore.Save(current); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"middle", "new"} {
		if _, _, err := gameStore.Save(gameFixture(id)); err != nil {
			t.Fatal(err)
		}
	}
	s := &Server{store: gameStore}
	for offset, id := range []string{"new", "middle", "old"} {
		w := httptest.NewRecorder()
		s.games(w, httptest.NewRequest("GET", fmt.Sprintf("/games?limit=1&offset=%d", offset), nil))
		var page struct {
			Games   []store.GameRow `json:"games"`
			Current *store.GameRow  `json:"current_game"`
			Next    *int            `json:"next_offset"`
			Total   int             `json:"total"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		if len(page.Games) != 1 || page.Games[0].ID != id || page.Total != 3 || page.Current == nil || page.Current.ID != "old" {
			t.Fatalf("page %d: %s", offset, w.Body)
		}
		if offset < 2 && (page.Next == nil || *page.Next != offset+1) || offset == 2 && page.Next != nil {
			t.Fatalf("next offset: %s", w.Body)
		}
	}
	for _, offset := range []string{"-1", "junk"} {
		w := httptest.NewRecorder()
		s.games(w, httptest.NewRequest("GET", "/games?offset="+offset, nil))
		if w.Code != 400 {
			t.Fatalf("invalid offset accepted: %s", offset)
		}
	}
}
func TestGamesListOrphanMarkerReadsNull(t *testing.T) {
	gameStore := testStore(t)
	current := gameFixture("old", "e2e4")
	current.Current = true
	if _, _, err := gameStore.Save(current); err != nil {
		t.Fatal(err)
	}
	// Bypass Delete's marker cleanup to simulate a marker/game race.
	if err := gameStore.DeleteGameRowForTest("old"); err != nil {
		t.Fatal(err)
	}
	if id := gameStore.CurrentID(); id != "old" {
		t.Fatalf("marker setup failed: %q", id)
	}
	s := &Server{store: gameStore}
	w := httptest.NewRecorder()
	s.games(w, httptest.NewRequest("GET", "/games?limit=200&offset=0", nil))
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	var page struct {
		CurrentID   *string        `json:"current_id"`
		CurrentGame *store.GameRow `json:"current_game"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.CurrentID != nil || page.CurrentGame != nil {
		t.Fatalf("orphan marker served dangling: %s", w.Body)
	}
}
func TestGamesHTTP(t *testing.T) {
	gameStore := testStore(t)
	s := &Server{store: gameStore}
	post := func(body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		s.games(w, httptest.NewRequest("POST", "/games", strings.NewReader(body)))
		return w
	}
	valid := `{"user_color":"white","elo_maia":1600,"elo_user":1400,"model":"79m","moves":["e2e4"],"current":true}`
	w := post(valid)
	if w.Code != 200 {
		t.Fatalf("save status %d: %s", w.Code, w.Body)
	}
	var saved store.GameRow
	if err := json.Unmarshal(w.Body.Bytes(), &saved); err != nil || saved.ID == "" {
		t.Fatalf("save body: %s, err = %v", w.Body, err)
	}
	for _, tc := range []struct {
		name, body, code string
		status           int
	}{
		{"malformed", "{", "invalid_json", 400},
		{"unknown field", `{"user_color":"white","flags":[]}`, "invalid_json", 400},
		{"trailing", valid + ` {}`, "invalid_json", 400},
		{"color", `{"user_color":"green","elo_maia":1,"elo_user":1,"model":"79m","moves":[]}`, "invalid_user_color", 400},
		{"elo missing", `{"user_color":"white","model":"79m","moves":[]}`, "missing_elo", 400},
		{"elo range", `{"user_color":"white","elo_maia":9999,"elo_user":1,"model":"79m","moves":[]}`, "invalid_elo", 400},
		{"model", `{"user_color":"white","elo_maia":1,"elo_user":1,"model":"9m","moves":[]}`, "invalid_model", 400},
		{"move shape", `{"user_color":"white","elo_maia":1,"elo_user":1,"model":"79m","moves":["e9"]}`, "invalid_move", 400},
		{"created", `{"user_color":"white","elo_maia":1,"elo_user":1,"model":"79m","moves":[],"created_at":"yesterday"}`, "invalid_created_at", 400},
		{"result", `{"user_color":"white","elo_maia":1,"elo_user":1,"model":"79m","moves":[],"result":"maia-wins"}`, "invalid_result", 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := post(tc.body)
			if w.Code != tc.status || !strings.Contains(w.Body.String(), `"code":"`+tc.code+`"`) {
				t.Fatalf("status %d: %s", w.Code, w.Body)
			}
		})
	}

	w = httptest.NewRecorder()
	s.games(w, httptest.NewRequest("GET", "/games", nil))
	if w.Code != 200 {
		t.Fatalf("list status %d: %s", w.Code, w.Body)
	}
	var listed struct {
		Games     []store.GameRow `json:"games"`
		CurrentID *string         `json:"current_id"`
		Total     int             `json:"total"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if listed.Total != 1 || len(listed.Games) != 1 || listed.CurrentID == nil || *listed.CurrentID != saved.ID {
		t.Fatalf("list body: %s", w.Body)
	}

	w = httptest.NewRecorder()
	s.games(w, httptest.NewRequest("GET", "/games?limit=0", nil))
	if w.Code != 400 {
		t.Fatalf("bad limit status %d", w.Code)
	}

	w = httptest.NewRecorder()
	s.gameByID(w, httptest.NewRequest("GET", "/games/"+saved.ID, nil))
	if w.Code != 200 {
		t.Fatalf("get status %d: %s", w.Code, w.Body)
	}
	w = httptest.NewRecorder()
	s.gameByID(w, httptest.NewRequest("GET", "/games/missing", nil))
	if w.Code != 404 || !strings.Contains(w.Body.String(), `"code":"not_found"`) {
		t.Fatalf("missing get: %d %s", w.Code, w.Body)
	}
	w = httptest.NewRecorder()
	s.gameByID(w, httptest.NewRequest("GET", "/games/", nil))
	if w.Code != 404 {
		t.Fatalf("empty id status %d", w.Code)
	}
	w = httptest.NewRecorder()
	s.gameByID(w, httptest.NewRequest("DELETE", "/games/"+saved.ID, nil))
	if w.Code != 204 {
		t.Fatalf("delete status %d: %s", w.Code, w.Body)
	}
	w = httptest.NewRecorder()
	s.gameByID(w, httptest.NewRequest("GET", "/games/"+saved.ID, nil))
	if w.Code != 404 {
		t.Fatalf("deleted game still visible: %d", w.Code)
	}
	w = httptest.NewRecorder()
	s.gameByID(w, httptest.NewRequest("DELETE", "/games/"+saved.ID, nil))
	if w.Code != 204 {
		t.Fatalf("repeat delete status %d", w.Code)
	}
	w = httptest.NewRecorder()
	s.games(w, httptest.NewRequest("PUT", "/games", nil))
	if w.Code != 405 {
		t.Fatalf("method status %d", w.Code)
	}
	w = httptest.NewRecorder()
	(&Server{}).games(w, httptest.NewRequest("GET", "/games", nil))
	if w.Code != 502 {
		t.Fatalf("nil store status %d", w.Code)
	}
}
