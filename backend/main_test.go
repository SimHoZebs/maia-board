package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestValidateMoveRequest(t *testing.T) {
	maiaElo, userElo := 1500, 1300
	request := moveRequest{
		FEN:       "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
		Moves:     []string{"e2e4"},
		EloMaia:   &maiaElo,
		EloUser:   &userElo,
		Model:     "79m",
		MaiaColor: "black",
	}
	engineRequest, model, err := validateMoveRequest(request)
	if err != nil {
		t.Fatal(err)
	}
	if model != "79m" || engineRequest.SelfElo != 1500 || engineRequest.OppoElo != 1300 {
		t.Fatalf("unexpected request mapping: %+v, model=%s", engineRequest, model)
	}
}

func TestValidateMoveRequestRejectsNonMaiaTurn(t *testing.T) {
	maiaElo, userElo := 1500, 1300
	_, _, err := validateMoveRequest(moveRequest{
		FEN:       "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
		EloMaia:   &maiaElo,
		EloUser:   &userElo,
		MaiaColor: "white",
	})
	if err == nil || err.Error() != "not_maia_turn: fen side-to-move is not maia_color" {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestPositionCommand(t *testing.T) {
	if got := positionCommand(EngineRequest{FEN: "current", Moves: []string{"e2e4"}}); got != "position startpos moves e2e4" {
		t.Fatalf("unexpected startpos command: %s", got)
	}
	if got := positionCommand(EngineRequest{FEN: "current", InitialFEN: "custom", Moves: []string{"e2e4"}}); got != "position fen custom moves e2e4" {
		t.Fatalf("unexpected custom command: %s", got)
	}
}

func TestHealthzMethod(t *testing.T) {
	app := &server{pool: NewEnginePool(NewWorker("79m", nil), NewWorker("5m", nil))}

	get := httptest.NewRecorder()
	app.healthz(get, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if get.Code != http.StatusOK {
		t.Fatalf("GET /healthz status = %d, want %d", get.Code, http.StatusOK)
	}

	post := httptest.NewRecorder()
	app.healthz(post, httptest.NewRequest(http.MethodPost, "/healthz", nil))
	if post.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /healthz status = %d, want %d", post.Code, http.StatusMethodNotAllowed)
	}
}
