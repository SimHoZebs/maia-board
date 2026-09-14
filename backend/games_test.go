package main

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func testStore(t *testing.T) *GameStore {
	t.Helper()
	store, err := NewGameStore(filepath.Join(t.TempDir(), "games.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.db.Close() })
	return store
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

func gameFixture(id string, moves ...string) gamePayload {
	maia, user := 1600, 1400
	return gamePayload{ID: id, UserColor: "white", EloMaia: &maia, EloUser: &user, Model: "79m", Moves: moves}
}

func TestGamesPersistenceBudget(t *testing.T) {
	s := &server{store: testStore(t)}
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
	store := testStore(t)
	current := gameFixture("old", "e2e4")
	current.Current = true
	if _, err := store.Save(current); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"middle", "new"} {
		if _, err := store.Save(gameFixture(id)); err != nil {
			t.Fatal(err)
		}
	}
	s := &server{store: store}
	for offset, id := range []string{"new", "middle", "old"} {
		w := httptest.NewRecorder()
		s.games(w, httptest.NewRequest("GET", fmt.Sprintf("/games?limit=1&offset=%d", offset), nil))
		var page struct {
			Games   []gameRow `json:"games"`
			Current *gameRow  `json:"current_game"`
			Next    *int      `json:"next_offset"`
			Total   int       `json:"total"`
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

func TestGameStoreGeneratesID(t *testing.T) {
	store := testStore(t)
	payload := gameFixture("", "e2e4")
	saved, err := store.Save(payload)
	if err != nil || saved.ID == "" {
		t.Fatalf("saved = %+v, err = %v", saved, err)
	}
}

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
	if err := validateGamePayload(&bad); err == nil || err.Code != "invalid_result" {
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

func TestGamesHTTP(t *testing.T) {
	store := testStore(t)
	s := &server{store: store}
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
	var saved gameRow
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
		Games     []gameRow `json:"games"`
		CurrentID *string   `json:"current_id"`
		Total     int       `json:"total"`
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
	(&server{}).games(w, httptest.NewRequest("GET", "/games", nil))
	if w.Code != 502 {
		t.Fatalf("nil store status %d", w.Code)
	}
}
