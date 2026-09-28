// Package apierror owns the shared request-error type returned by
// validation across chess, engine, store, openings, and server packages.
// A RequestError always maps to HTTP 400 with its Code; transport and
// engine failures use plain errors mapped by the server envelope.
package apierror

// RequestError is a machine-readable client error: Code is the API error
// code (invalid_fen, invalid_move, ...), Message is the human text.
type RequestError struct {
	Code    string
	Message string
}

func (e *RequestError) Error() string { return e.Code + ": " + e.Message }

// Error is the JSON error envelope served on every failure.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
