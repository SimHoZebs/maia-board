package engine

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"testing"

	"maia-board/backend/internal/chess"
	"maia-board/backend/internal/sched"
)

func TestTemperatureJSONHelper(t *testing.T) {
	if os.Getenv("MAIA_TEMP_HELPER") != "1" {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	index := 0
	fmt.Println(`{"ready":true}`)
	for scanner.Scan() {
		var request MaiaRequest
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
	defer worker.Close()
	for _, temperature := range []float64{.7, 0} {
		_, release, err := worker.Predict(context.Background(), context.Background(), sched.PriorityFocus, 0, MaiaRequest{FEN: startFEN, SelfElo: 1600, OppoElo: 1600, Temperature: temperature})
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
		if chess.ValidTemperature(value) {
			t.Fatalf("accepted temperature %v", value)
		}
	}
	for _, settings := range []StockfishSettings{{TimeMS: 249, Lines: 2}, {TimeMS: 30001, Lines: 2}, {TimeMS: 750}, {TimeMS: 750, Lines: 6}, {TimeMS: 750, Lines: 2, Depth: -1}, {TimeMS: 750, Lines: 2, Depth: 41}} {
		if ValidateEvaluationRequest(&EvaluationRequest{FEN: startFEN, Settings: &settings}) == nil {
			t.Fatalf("accepted %+v", settings)
		}
	}
	settings := &StockfishSettings{TimeMS: 750, Lines: 2}
	if settings.Policy() != "sf19-ms750-mpv2-d0-t4-h128-v3" {
		t.Fatal(settings.Policy())
	}
	settings = &StockfishSettings{TimeMS: 30000, Lines: 5, Depth: 40}
	if settings.Validate() != nil || settings.Policy() != "sf19-ms30000-mpv5-d40-t4-h128-v3" {
		t.Fatal(settings.Policy())
	}
	if (*StockfishSettings)(nil).Policy() != SearchPolicy {
		t.Fatal("legacy policy changed")
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
