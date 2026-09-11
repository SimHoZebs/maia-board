package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

const analysisBody = `{"settings":{"elo_maia":1600,"elo_user":1600,"model":"79m","search_policy":"sf19-n100k-ms750-mpv2-t1-h64-v1","maia_ref":"1e13597c42d4858b7cfd7cfdae01e297263364b2"},"positions":6,"failed":0}`

func putAnalysis(t *testing.T, s *server, hash, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	s.analyses(w, httptest.NewRequest("PUT", "/analyses/"+hash, strings.NewReader(body)))
	return w
}

func TestAnalysisRecordRoundTrip(t *testing.T) {
	s := &server{store: testStore(t)}
	hash := "0123456789abcdef"
	w := putAnalysis(t, s, hash, analysisBody)
	if w.Code != 200 {
		t.Fatalf("put status %d: %s", w.Code, w.Body)
	}
	var record analysisRecord
	if err := json.Unmarshal(w.Body.Bytes(), &record); err != nil {
		t.Fatal(err)
	}
	if record.LineHash != hash || record.Positions != 6 || record.Failed != 0 || record.CompletedAt == "" {
		t.Fatalf("record = %+v", record)
	}
	if record.Settings.EloMaia != 1600 || record.Settings.Model != "79m" {
		t.Fatalf("settings = %+v", record.Settings)
	}
	w = httptest.NewRecorder()
	s.analyses(w, httptest.NewRequest("GET", "/analyses/"+hash, nil))
	if w.Code != 200 {
		t.Fatalf("get status %d: %s", w.Code, w.Body)
	}
	var listed struct {
		Analyses []analysisRecord `json:"analyses"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Analyses) != 1 || listed.Analyses[0].CompletedAt != record.CompletedAt {
		t.Fatalf("listed = %+v", listed)
	}
}

func TestAnalysisRecordUpsert(t *testing.T) {
	s := &server{store: testStore(t)}
	hash := "ffffffffffffffff"
	if w := putAnalysis(t, s, hash, analysisBody); w.Code != 200 {
		t.Fatalf("put status %d: %s", w.Code, w.Body)
	}
	w := putAnalysis(t, s, hash, strings.Replace(analysisBody, `"positions":6`, `"positions":7`, 1))
	if w.Code != 200 {
		t.Fatalf("reput status %d: %s", w.Code, w.Body)
	}
	var record analysisRecord
	if err := json.Unmarshal(w.Body.Bytes(), &record); err != nil {
		t.Fatal(err)
	}
	if record.Positions != 7 {
		t.Fatalf("positions = %d", record.Positions)
	}
	w = httptest.NewRecorder()
	s.analyses(w, httptest.NewRequest("GET", "/analyses?line="+hash, nil))
	var listed struct {
		Analyses []analysisRecord `json:"analyses"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Analyses) != 1 {
		t.Fatalf("listed = %+v", listed)
	}
}

func TestAnalysisMissReturnsEmptyList(t *testing.T) {
	s := &server{store: testStore(t)}
	for _, target := range []string{"/analyses/aaaaaaaaaaaaaaaa", "/analyses?line=aaaaaaaaaaaaaaaa", "/analyses"} {
		w := httptest.NewRecorder()
		s.analyses(w, httptest.NewRequest("GET", target, nil))
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"analyses":[]`) {
			t.Fatalf("%s: %d %s", target, w.Code, w.Body)
		}
	}
}

func TestAnalysisValidation(t *testing.T) {
	s := &server{store: testStore(t)}
	hash := "bbbbbbbbbbbbbbbb"
	for _, tc := range []struct {
		name, method, target, body, code string
		status                           int
	}{
		{"short hash", "PUT", "/analyses/abc", analysisBody, "invalid_request", 400},
		{"non-hex hash", "PUT", "/analyses/zzzzzzzzzzzzzzzz", analysisBody, "invalid_request", 400},
		{"bad elo", "PUT", "/analyses/" + hash, strings.Replace(analysisBody, "1600", "9000", 1), "invalid_elo", 400},
		{"bad model", "PUT", "/analyses/" + hash, strings.Replace(analysisBody, "79m", "99m", 1), "invalid_model", 400},
		{"empty policy", "PUT", "/analyses/" + hash, strings.Replace(analysisBody, "sf19-n100k-ms750-mpv2-t1-h64-v1", "", 1), "invalid_search_policy", 400},
		{"too many positions", "PUT", "/analyses/" + hash, strings.Replace(analysisBody, `"positions":6`, `"positions":258`, 1), "invalid_positions", 400},
		{"failed exceeds positions", "PUT", "/analyses/" + hash, strings.Replace(analysisBody, `"failed":0`, `"failed":7`, 1), "invalid_failed", 400},
		{"unknown field", "PUT", "/analyses/" + hash, strings.Replace(analysisBody, `"failed":0`, `"failed":0,"extra":1`, 1), "invalid_json", 400},
		{"trailing object", "PUT", "/analyses/" + hash, analysisBody + " {}", "invalid_json", 400},
		{"bad batch hash", "GET", "/analyses?line=xyz", "", "invalid_request", 400},
		{"method not allowed", "POST", "/analyses/" + hash, "", "method_not_allowed", 405},
	} {
		w := httptest.NewRecorder()
		s.analyses(w, httptest.NewRequest(tc.method, tc.target, strings.NewReader(tc.body)))
		if w.Code != tc.status || !strings.Contains(w.Body.String(), `"code":"`+tc.code+`"`) {
			t.Fatalf("%s: %d %s", tc.name, w.Code, w.Body)
		}
	}
}

func TestAnalysisBatchLookup(t *testing.T) {
	s := &server{store: testStore(t)}
	first, second := "1111111111111111", "2222222222222222"
	if w := putAnalysis(t, s, first, analysisBody); w.Code != 200 {
		t.Fatalf("put status %d: %s", w.Code, w.Body)
	}
	w := httptest.NewRecorder()
	s.analyses(w, httptest.NewRequest("GET", "/analyses?line="+first+"&line="+second, nil))
	if w.Code != 200 {
		t.Fatalf("batch status %d: %s", w.Code, w.Body)
	}
	var listed struct {
		Analyses []analysisRecord `json:"analyses"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Analyses) != 1 || listed.Analyses[0].LineHash != first {
		t.Fatalf("listed = %+v", listed)
	}
	many := "/analyses?" + strings.Repeat("line=aaaaaaaaaaaaaaaa&", analysesMaxLines+1)
	w = httptest.NewRecorder()
	s.analyses(w, httptest.NewRequest("GET", many, nil))
	if w.Code != 400 {
		t.Fatalf("over-cap status %d: %s", w.Code, w.Body)
	}
}
