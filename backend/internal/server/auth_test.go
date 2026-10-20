package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
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
	importBody := `{"games":[{"user_color":"white","elo_maia":1500,"elo_user":1300,"model":"79m","moves":["e2e4"],"created_at":"2024-01-01T00:00:00Z","source":"lichess:imp00001","opponent":"foe-a"},{"user_color":"black","elo_maia":1500,"elo_user":1300,"model":"79m","moves":["e2e4","e7e5"],"source":"lichess:imp00002","opponent":"foe-b"}]}`
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

func TestImportDedupeAndStatus(t *testing.T) {
	s := authedServer(t)
	_, token := loginAs(t, s, "Importer")
	entry := func(source string) string {
		return `{"user_color":"white","elo_maia":1500,"elo_user":1300,"model":"79m","moves":["e2e4"],"source":"` + source + `","opponent":"foe-x"}`
	}
	entryNamed := func(source, opponent string) string {
		return `{"user_color":"white","elo_maia":1500,"elo_user":1300,"model":"79m","moves":["e2e4"],"source":"` + source + `","opponent":"` + opponent + `"}`
	}
	body := `{"provider":"lichess","username":"bob","games":[` + entryNamed("lichess:aaa11111", "foe-one") + `,` + entry("lichess:bbb22222") + `]}`
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
	if first.Saved[0].Opponent != "foe-one" || first.Saved[0].Source != "lichess:aaa11111" {
		t.Fatalf("opponent not stamped: %+v", first.Saved[0])
	}
	// Re-importing a fully-named row is a clean skip (opponent backfill
	// only fires for pre-name rows; strict imports always
	// carry a name, so there is nothing to refresh here).
	w = authed(t, s, http.MethodPost, "/imports/games", `{"provider":"lichess","username":"bob","games":[`+entryNamed("lichess:bbb22222", "foe-two")+`]}`, token)
	if w.Code != http.StatusOK {
		t.Fatalf("backfill import: %d %s", w.Code, w.Body)
	}
	var backfilled struct {
		Skipped   int `json:"skipped"`
		Refreshed int `json:"refreshed"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &backfilled); err != nil || backfilled.Skipped != 1 || backfilled.Refreshed != 0 {
		t.Fatalf("backfill counts: %s err=%v", w.Body, err)
	}
	got, err := s.store.Get(first.Saved[1].ID)
	if err != nil || got.Opponent != "foe-x" {
		t.Fatalf("named row preserved: %+v %v", got, err)
	}
	// Rating diffs stamp on import, backfill on re-import, and clear on
	// single play saves (server-owned like opponent/source).
	diffBody := `{"provider":"lichess","username":"bob","games":[{"user_color":"white","elo_maia":1500,"elo_user":1300,"model":"79m","moves":["e2e4"],"source":"lichess:diff0001","opponent":"foe-diff","rating_diff":14}]}`
	w = authed(t, s, http.MethodPost, "/imports/games", diffBody, token)
	if w.Code != http.StatusOK {
		t.Fatalf("diff import: %d %s", w.Code, w.Body)
	}
	var diffed struct {
		Saved []store.GameRow `json:"saved"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &diffed); err != nil || len(diffed.Saved) != 1 || diffed.Saved[0].RatingDiff == nil || *diffed.Saved[0].RatingDiff != 14 {
		t.Fatalf("diff stamp: %s err=%v", w.Body, err)
	}
	w = authed(t, s, http.MethodPost, "/imports/games", `{"provider":"lichess","username":"bob","games":[{"user_color":"white","elo_maia":1500,"elo_user":1300,"model":"79m","moves":["e2e4"],"source":"lichess:bbb22222","rating_diff":-3}]}`, token)
	if w.Code != http.StatusOK {
		t.Fatalf("diff backfill import: %d %s", w.Code, w.Body)
	}
	got, err = s.store.Get(first.Saved[1].ID)
	if err != nil || got.RatingDiff == nil || *got.RatingDiff != -3 {
		t.Fatalf("backfilled diff: %+v %v", got, err)
	}
	w = authed(t, s, http.MethodPost, "/imports/games", `{"provider":"lichess","games":[{"user_color":"white","elo_maia":1500,"elo_user":1300,"model":"79m","moves":["e2e4"],"source":"lichess:bad99999","opponent":"foe-bad","rating_diff":5000}]}`, token)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad diff: %d %s", w.Code, w.Body)
	}
	w = authed(t, s, http.MethodPost, "/imports/games", body, token)
	var second struct {
		Saved     []store.GameRow `json:"saved"`
		Skipped   int             `json:"skipped"`
		Refreshed int             `json:"refreshed"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &second); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusOK || len(second.Saved) != 0 || second.Skipped != 2 || second.Refreshed != 0 {
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
	w = authed(t, s, http.MethodPost, "/imports/games", `{"provider":"lichess","games":[`+entryNamed("lichess:ddd44444", "012345678901234567890123456789012345678901234567890123456789012345")+`]}`, token)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad opponent: %d %s", w.Code, w.Body)
	}
	w = authed(t, s, http.MethodPost, "/games", `{"user_color":"white","elo_maia":1600,"elo_user":1400,"model":"79m","moves":["e2e4"],"opponent":"spoofed"}`, token)
	if w.Code != http.StatusOK {
		t.Fatalf("single save: %d %s", w.Code, w.Body)
	}
	var single store.GameRow
	if err := json.Unmarshal(w.Body.Bytes(), &single); err != nil || single.Opponent != "Maia 1600" || single.Source != "local" || single.RatingDiff != nil {
		t.Fatalf("single save stamp: %s err=%v", w.Body, err)
	}
	w = authed(t, s, http.MethodGet, "/imports/status", "", token)
	if w.Code != http.StatusOK {
		t.Fatalf("status: %d %s", w.Code, w.Body)
	}
	var status struct {
		Last  *store.ImportRun `json:"last"`
		Total int              `json:"total"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &status); err != nil || status.Last == nil || status.Total != 4 {
		t.Fatalf("status body: %s err=%v", w.Body, err)
	}
	if w := authed(t, s, http.MethodGet, "/imports/status", "", ""); w.Code != http.StatusUnauthorized {
		t.Fatalf("anon status: %d", w.Code)
	}
}

func TestImportTimeControl(t *testing.T) {
	s := authedServer(t)
	_, token := loginAs(t, s, "ClockImporter")
	body := `{"provider":"lichess","username":"bob","games":[{"user_color":"white","elo_maia":1500,"elo_user":1300,"model":"79m","moves":["e2e4"],"source":"lichess:clk10001","opponent":"foe-clock","time_control":"300+3","speed":"blitz"}]}`
	w := authed(t, s, http.MethodPost, "/imports/games", body, token)
	if w.Code != http.StatusOK {
		t.Fatalf("clock import: %d %s", w.Code, w.Body)
	}
	var imported struct {
		Saved []store.GameRow `json:"saved"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &imported); err != nil || len(imported.Saved) != 1 || imported.Saved[0].TimeControl == nil || *imported.Saved[0].TimeControl != "300+3" || imported.Saved[0].Speed == nil || *imported.Saved[0].Speed != "blitz" {
		t.Fatalf("clock stamp: %s err=%v", w.Body, err)
	}
	// Correspondence days stamp, and re-imports backfill clocks.
	corr := `{"provider":"lichess","username":"bob","games":[{"user_color":"black","elo_maia":1500,"elo_user":1300,"model":"79m","moves":["e2e4"],"source":"lichess:clk10002","opponent":"foe-corr","time_control":"3d","speed":"correspondence"}]}`
	if w := authed(t, s, http.MethodPost, "/imports/games", corr, token); w.Code != http.StatusOK {
		t.Fatalf("correspondence import: %d %s", w.Code, w.Body)
	}
	// Unknown pools are rejected before they reach the store.
	bad := `{"provider":"lichess","games":[{"user_color":"white","elo_maia":1500,"elo_user":1300,"model":"79m","moves":["e2e4"],"source":"lichess:clk10003","speed":"hyperbullet"}]}`
	if w := authed(t, s, http.MethodPost, "/imports/games", bad, token); w.Code != http.StatusBadRequest {
		t.Fatalf("bad speed: %d %s", w.Code, w.Body)
	}
	// Single play saves stay untimed: client-sent clocks never stick.
	w = authed(t, s, http.MethodPost, "/games", `{"user_color":"white","elo_maia":1600,"elo_user":1400,"model":"79m","moves":["e2e4"],"time_control":"300+3","speed":"blitz"}`, token)
	if w.Code != http.StatusOK {
		t.Fatalf("single save: %d %s", w.Code, w.Body)
	}
	var single store.GameRow
	if err := json.Unmarshal(w.Body.Bytes(), &single); err != nil || single.TimeControl != nil || single.Speed != nil {
		t.Fatalf("single save clock: %s err=%v", w.Body, err)
	}
}

func TestImportClocks(t *testing.T) {
	s := authedServer(t)
	_, token := loginAs(t, s, "ClockReader")
	body := `{"provider":"lichess","games":[{"user_color":"white","elo_maia":1500,"elo_user":1300,"model":"79m","moves":["e2e4","e7e5"],"source":"lichess:clk20001","opponent":"foe-read","time_control":"180+2","speed":"blitz","clocks":[18000,17950]}]}`
	w := authed(t, s, http.MethodPost, "/imports/games", body, token)
	if w.Code != http.StatusOK {
		t.Fatalf("readings import: %d %s", w.Code, w.Body)
	}
	var imported struct {
		Saved []store.GameRow `json:"saved"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &imported); err != nil || len(imported.Saved) != 1 || !slices.Equal(imported.Saved[0].Clocks, []int{18000, 17950}) {
		t.Fatalf("readings stamp: %s err=%v", w.Body, err)
	}
	// Re-imports backfill readings on rows saved before clocks existed.
	w = authed(t, s, http.MethodPost, "/imports/games", `{"provider":"lichess","games":[{"user_color":"white","elo_maia":1500,"elo_user":1300,"model":"79m","moves":["e2e4","e7e5"],"source":"lichess:clk20001","clocks":[18000,17950]}]}`, token)
	if w.Code != http.StatusOK {
		t.Fatalf("readings backfill import: %d %s", w.Code, w.Body)
	}
	got, err := s.store.Get(imported.Saved[0].ID)
	if err != nil || !slices.Equal(got.Clocks, []int{18000, 17950}) {
		t.Fatalf("backfilled readings: %+v %v", got, err)
	}
	// Length must match the move list.
	bad := `{"provider":"lichess","games":[{"user_color":"white","elo_maia":1500,"elo_user":1300,"model":"79m","moves":["e2e4","e7e5"],"source":"lichess:clk20002","opponent":"foe-bad","clocks":[18000]}]}`
	if w := authed(t, s, http.MethodPost, "/imports/games", bad, token); w.Code != http.StatusBadRequest {
		t.Fatalf("short readings: %d %s", w.Code, w.Body)
	}
	// Single play saves stay reading-free.
	w = authed(t, s, http.MethodPost, "/games", `{"user_color":"white","elo_maia":1600,"elo_user":1400,"model":"79m","moves":["e2e4","e7e5"],"clocks":[18000,17950]}`, token)
	if w.Code != http.StatusOK {
		t.Fatalf("single save: %d %s", w.Code, w.Body)
	}
	var single store.GameRow
	if err := json.Unmarshal(w.Body.Bytes(), &single); err != nil || single.Clocks != nil {
		t.Fatalf("single save readings: %s err=%v", w.Body, err)
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
