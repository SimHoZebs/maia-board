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
	_ = alice
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
