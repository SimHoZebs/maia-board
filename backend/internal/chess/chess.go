// Package chess owns pure chess-input validation shared by the HTTP
// boundary and the engine adapters: FEN shape, UCI move shape, Elo range,
// and temperature range. It performs no board replay; history consistency
// is enforced by the Python workers.
package chess

import (
	"math"
	"regexp"
	"strconv"
	"strings"

	"maia-board/backend/internal/apierror"
)

var UCIMovePattern = regexp.MustCompile(`^[a-h][1-8][a-h][1-8][qrbn]?$`)

var EPSquarePattern = regexp.MustCompile(`^[a-h][36]$`)

// NormalizeFEN checks the six-field FEN shape and returns the normalized
// string plus the side to move ("w" or "b").
func NormalizeFEN(fen string) (string, string, error) {
	fields := strings.Fields(fen)
	if len(fields) != 6 {
		return "", "", &apierror.RequestError{Code: "invalid_fen", Message: "fen must contain six fields"}
	}
	if fields[1] != "w" && fields[1] != "b" {
		return "", "", &apierror.RequestError{Code: "invalid_fen", Message: "fen side-to-move must be w or b"}
	}
	ranks := strings.Split(fields[0], "/")
	if len(ranks) != 8 {
		return "", "", &apierror.RequestError{Code: "invalid_fen", Message: "fen board must contain eight ranks"}
	}
	for _, rank := range ranks {
		count := 0
		for _, piece := range rank {
			switch {
			case piece >= '1' && piece <= '8':
				count += int(piece - '0')
			case strings.ContainsRune("pnbrqkPNBRQK", piece):
				count++
			default:
				return "", "", &apierror.RequestError{Code: "invalid_fen", Message: "fen contains an invalid board symbol"}
			}
		}
		if count != 8 {
			return "", "", &apierror.RequestError{Code: "invalid_fen", Message: "fen rank does not contain eight squares"}
		}
	}
	if fields[2] != "-" {
		for _, piece := range fields[2] {
			if !strings.ContainsRune("KQkq", piece) {
				return "", "", &apierror.RequestError{Code: "invalid_fen", Message: "fen contains invalid castling rights"}
			}
		}
	}
	if fields[3] != "-" && !EPSquarePattern.MatchString(fields[3]) {
		return "", "", &apierror.RequestError{Code: "invalid_fen", Message: "fen contains invalid en-passant square"}
	}
	for _, field := range fields[4:] {
		value, err := strconv.Atoi(field)
		if err != nil || value < 0 {
			return "", "", &apierror.RequestError{Code: "invalid_fen", Message: "fen move counters must be non-negative integers"}
		}
	}
	return strings.Join(fields, " "), fields[1], nil
}

// ValidateUCIMoves rejects non-UCI-shaped history entries.
func ValidateUCIMoves(moves []string) *apierror.RequestError {
	for _, move := range moves {
		if !UCIMovePattern.MatchString(move) {
			return &apierror.RequestError{Code: "invalid_move", Message: "moves must contain UCI moves"}
		}
	}
	return nil
}

// ValidateElo requires both Maia and user ratings in 0–5000.
func ValidateElo(eloMaia, eloUser *int) *apierror.RequestError {
	if eloMaia == nil || eloUser == nil {
		return &apierror.RequestError{Code: "missing_elo", Message: "elo_maia and elo_user are required"}
	}
	if *eloMaia < 0 || *eloMaia > 5000 || *eloUser < 0 || *eloUser > 5000 {
		return &apierror.RequestError{Code: "invalid_elo", Message: "Elo values must be between 0 and 5000"}
	}
	return nil
}

// ValidTemperature accepts the 0–2 sampling range (0 = argmax).
func ValidTemperature(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && value <= 2
}
