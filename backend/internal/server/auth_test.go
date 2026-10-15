package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"maia-board/backend/internal/store"
)

func authedServer(t *testing.T) *Server {
	t.Helper()
	s := &Server{store: testStore(t)}
	s.EnableAuthForTest()
	s.reviews = NewReviewJobs(s)
	return s
}

func loginAs(t *testing.T, s *Server, name string) (store.User, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/auth/local", strings.NewReader(`{"display_name":"`+name+`"}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("login %s: %d %s", name, w.Code, w.Body)
	}
	var user store.User
	if err := json.Unmarshal(w.Body.Bytes(), &user); err != nil || user.ID == "" {
		t.Fatalf("login body: %s err=%v", w.Body, err)
	}
	cookie := w.Result().Cookies()
	if len(cookie) == 0 {
		t.Fatal("login set no cookie")
	}
	return user, cookie[0].Value
}

func authed(t *testing.T, s *Server, method, path, body, token string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	if method == http.MethodPost || method == http.MethodPut || method == http.MethodPatch {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: token})
	}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	return w
}

func TestAuthGatesAndOwnership(t *testing.T) {
	s := authedServer(t)
	for _, tc := range []struct{ method, path, body string }{
		{http.MethodGet, "/games", ""},
		{http.MethodPost, "/games", `{"user_color":"white","elo_maia":1600,"elo_user":1400,"model":"79m","moves":[]}`},
		{http.MethodGet, "/games/abc", ""},
		{http.MethodPost, "/move", `{"fen":"` + startFEN + `","moves":[],"elo_maia":1600,"elo_user":1600,"model":"79m","maia_color":"white"}`},
		{http.MethodPost, "/evaluate", `{"fen":"` + startFEN + `","moves":[]}`},
		{http.MethodPost, "/evaluations/lookup", `{"line":{"initial_fen":"` + startFEN + `","moves":[]},"requests":[{"engine":"sf","fen":"` + startFEN + `","ply":0}]}`},
		{http.MethodPost, "/reviews", `{"line":{"initial_fen":"` + startFEN + `","moves":[]},"requests":[{"engine":"maia","fen":"` + startFEN + `","ply":0,"elo_maia":1600,"elo_user":1600,"model":"79m"}]}`},
		{http.MethodPost, "/imports/games", `{"games":[]}`},
		{http.MethodPost, "/imports/adopt", ""},
	} {
		if w := authed(t, s, tc.method, tc.path, tc.body, ""); w.Code != http.StatusUnauthorized && !(tc.path == "/imports/games" && w.Code == http.StatusUnauthorized) {
			t.Fatalf("%s %s: status %d, want 401", tc.method, tc.path, w.Code)
		}
	}
	alice, aliceToken := loginAs(t, s, "Alice")
	if w := authed(t, s, http.MethodGet, "/games", "", aliceToken); w.Code != http.StatusOK {
		t.Fatalf("alice list: %d %s", w.Code, w.Body)
	}
	w := authed(t, s, http.MethodPost, "/games", `{"user_color":"white","elo_maia":1600,"elo_user":1400,"model":"79m","moves":["e2e4"],"current":true}`, aliceToken)
	if w.Code != http.StatusOK {
		t.Fatalf("alice save: %d %s", w.Code, w.Body)
	}
	var saved store.GameRow
	if err := json.Unmarshal(w.Body.Bytes(), &saved); err != nil || saved.OwnerID != alice.ID {
		t.Fatalf("owner not stamped: %s err=%v", w.Body, err)
	}
	_, bobToken := loginAs(t, s, "Bob")
	if w := authed(t, s, http.MethodGet, "/games/"+saved.ID, "", bobToken); w.Code != http.StatusNotFound {
		t.Fatalf("cross-owner read: %d %s", w.Code, w.Body)
	}
	if w := authed(t, s, http.MethodDelete, "/games/"+saved.ID, "", bobToken); w.Code != http.StatusNotFound {
		t.Fatalf("cross-owner delete: %d %s", w.Code, w.Body)
	}
	importBody := `{"games":[{"user_color":"white","elo_maia":1500,"elo_user":1300,"model":"79m","moves":["e2e4"],"created_at":"2024-01-01T00:00:00Z"},{"user_color":"black","elo_maia":1500,"elo_user":1300,"model":"79m","moves":["e2e4","e7e5"]}]}`
	w = authed(t, s, http.MethodPost, "/imports/games", importBody, bobToken)
	if w.Code != http.StatusOK {
		t.Fatalf("bulk import: %d %s", w.Code, w.Body)
	}
	var imported struct {
		Saved  []store.GameRow   `json:"saved"`
		Errors map[string]string `json:"errors"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &imported); err != nil || len(imported.Saved) != 2 {
		t.Fatalf("import body: %s err=%v", w.Body, err)
	}
	w = authed(t, s, http.MethodGet, "/games", "", bobToken)
	var page struct {
		Total int `json:"total"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || page.Total != 2 {
		t.Fatalf("bob list: %s err=%v", w.Body, err)
	}
	w = authed(t, s, http.MethodGet, "/games", "", aliceToken)
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || page.Total != 1 {
		t.Fatalf("alice list after import: %s err=%v", w.Body, err)
	}
	if w := authed(t, s, http.MethodPost, "/auth/logout", "", bobToken); w.Code != http.StatusNoContent {
		t.Fatalf("logout: %d %s", w.Code, w.Body)
	}
	if w := authed(t, s, http.MethodGet, "/games", "", bobToken); w.Code != http.StatusUnauthorized {
		t.Fatalf("revoked session accepted: %d", w.Code)
	}
}

func TestAdoptEndpoint(t *testing.T) {
	s := authedServer(t)
	if w := authed(t, s, http.MethodPost, "/imports/adopt", "", ""); w.Code != http.StatusUnauthorized {
		t.Fatalf("anon adopt: %d", w.Code)
	}
	if w := authed(t, s, http.MethodGet, "/imports/adopt", "", ""); w.Code != http.StatusUnauthorized {
		t.Fatalf("anon adopt count: %d", w.Code)
	}
	// Legacy row written before auth existed (direct store save, no owner).
	maia, user := 1600, 1400
	if _, _, err := s.store.Save(store.GamePayload{ID: "legacy", UserColor: "white", EloMaia: &maia, EloUser: &user, Model: "79m", Moves: []string{"e2e4"}}); err != nil {
		t.Fatal(err)
	}
	alice, aliceToken := loginAs(t, s, "Alice")
	if w := authed(t, s, http.MethodGet, "/games", "", aliceToken); w.Code != http.StatusOK {
		t.Fatalf("alice list: %d", w.Code)
	}
	w := authed(t, s, http.MethodPost, "/imports/adopt", "", aliceToken)
	if w.Code != http.StatusOK {
		t.Fatalf("adopt: %d %s", w.Code, w.Body)
	}
	var result struct {
		Adopted int `json:"adopted"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || result.Adopted != 1 {
		t.Fatalf("adopt body: %s err=%v", w.Body, err)
	}
	if w := authed(t, s, http.MethodGet, "/games/legacy", "", aliceToken); w.Code != http.StatusOK {
		t.Fatalf("adopted row unreadable: %d %s", w.Code, w.Body)
	}
	w = authed(t, s, http.MethodGet, "/imports/adopt", "", aliceToken)
	if w.Code != http.StatusOK {
		t.Fatalf("adopt count: %d %s", w.Code, w.Body)
	}
	var count struct {
		Unowned int `json:"unowned"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &count); err != nil || count.Unowned != 0 {
		t.Fatalf("adopt count body: %s err=%v", w.Body, err)
	}
	_ = alice
}

func TestImportDedupeAndStatus(t *testing.T) {
	s := authedServer(t)
	_, token := loginAs(t, s, "Importer")
	entry := func(source string) string {
		return `{"user_color":"white","elo_maia":1500,"elo_user":1300,"model":"79m","moves":["e2e4"],"source":"` + source + `"}`
	}
	body := `{"provider":"lichess","username":"bob","games":[` + entry("lichess:aaa11111") + `,` + entry("lichess:bbb22222") + `]}`
	w := authed(t, s, http.MethodPost, "/imports/games", body, token)
	if w.Code != http.StatusOK {
		t.Fatalf("import: %d %s", w.Code, w.Body)
	}
	var first struct {
		Saved   []store.GameRow `json:"saved"`
		Skipped int             `json:"skipped"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &first); err != nil || len(first.Saved) != 2 || first.Skipped != 0 {
		t.Fatalf("first import: %s err=%v", w.Body, err)
	}
	w = authed(t, s, http.MethodPost, "/imports/games", body, token)
	var second struct {
		Saved   []store.GameRow `json:"saved"`
		Skipped int             `json:"skipped"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &second); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusOK || len(second.Saved) != 0 || second.Skipped != 2 {
		t.Fatalf("re-import: status %d body %s", w.Code, w.Body)
	}
	w = authed(t, s, http.MethodPost, "/imports/games", `{"provider":"lichess","games":[`+entry("bogus")+`]}`, token)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad source: %d %s", w.Code, w.Body)
	}
	w = authed(t, s, http.MethodPost, "/imports/games", `{"provider":"chesscom","games":[`+entry("lichess:ccc33333")+`]}`, token)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad provider: %d %s", w.Code, w.Body)
	}
	w = authed(t, s, http.MethodGet, "/imports/status", "", token)
	if w.Code != http.StatusOK {
		t.Fatalf("status: %d %s", w.Code, w.Body)
	}
	var status struct {
		Last  *store.ImportRun `json:"last"`
		Total int              `json:"total"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &status); err != nil || status.Last == nil || status.Last.Skipped != 2 || status.Total != 2 {
		t.Fatalf("status body: %s err=%v", w.Body, err)
	}
	if w := authed(t, s, http.MethodGet, "/imports/status", "", ""); w.Code != http.StatusUnauthorized {
		t.Fatalf("anon status: %d", w.Code)
	}
}

func TestReviewOwnership(t *testing.T) {
	s := authedServer(t)
	alice, aliceToken := loginAs(t, s, "Alice")
	_, bobToken := loginAs(t, s, "Bob")
	job := &batchJob{id: "job-alice", owner: alice.ID, subs: make(map[chan BatchProgress]struct{})}
	s.reviews.mu.Lock()
	s.reviews.jobs[job.id] = job
	s.reviews.mu.Unlock()
	if w := authed(t, s, http.MethodGet, "/reviews/job-alice", "", bobToken); w.Code != http.StatusNotFound {
		t.Fatalf("cross-owner status: %d %s", w.Code, w.Body)
	}
	if w := authed(t, s, http.MethodGet, "/reviews/job-alice", "", aliceToken); w.Code != http.StatusOK {
		t.Fatalf("owner status: %d %s", w.Code, w.Body)
	}
	if w := authed(t, s, http.MethodGet, "/reviews/job-alice/events", "", bobToken); w.Code != http.StatusNotFound {
		t.Fatalf("cross-owner stream: %d %s", w.Code, w.Body)
	}
}
