// Command maia-board serves the Maia Board API and static frontend,
// running Maia and Stockfish engine workers locally.
package main

import (
	"log"
	"net/http"
	"os"
	"time"

	"maia-board/backend/internal/engine"
	"maia-board/backend/internal/openings"
	"maia-board/backend/internal/server"
	"maia-board/backend/internal/store"
)

func main() {
	workerPath := getenv("MAIA3_WORKER", "/app/maia3_worker.py")
	python := getenv("PYTHON", "python3")
	largeModel := getenv("MAIA3_MODEL_79M", "79m")
	smallModel := getenv("MAIA3_MODEL_5M", "5m")
	device := getenv("MAIA3_DEVICE", "auto")
	if !validDevice(device) {
		log.Fatalf("invalid MAIA3_DEVICE %q: must be auto, cpu, or cuda[:N]", device)
	}
	idleTimeout, err := parseIdleTimeout(getenv("MAIA3_IDLE_TIMEOUT", "10m"))
	if err != nil {
		log.Fatalf("invalid MAIA3_IDLE_TIMEOUT: %v", err)
	}
	port := getenv("PORT", "8080")
	staticDir := getenv("STATIC_DIR", "/app/static")

	large := engine.NewWorker("79m", workerCommand(python, workerPath, largeModel, device))
	small := engine.NewWorker("5m", workerCommand(python, workerPath, smallModel, device))
	large.SetIdleTimeout(idleTimeout)
	small.SetIdleTimeout(idleTimeout)
	gameStore, err := store.NewGameStore(getenv("DB_PATH", "maia-board.db"))
	if err != nil {
		log.Fatalf("open game database: %v", err)
	}
	pool := engine.NewEnginePool(large, small)
	app := server.NewServer(pool,
		engine.NewEvaluator(python, getenv("STOCKFISH_WORKER", "/app/stockfish_worker.py"), getenv("STOCKFISH_BINARY", "/app/stockfish")),
		gameStore,
		openings.NewOpeningsLookup(python, getenv("OPENINGS_LOOKUP", "/app/openings_lookup.py")),
		staticDir)
	if idleTimeout > 0 {
		startIdleReaper(pool, idleTimeout)
	}

	address := ":" + port
	log.Printf("maia-board listening on %s", address)
	// Bounded reads keep slow clients from holding connections; no
	// WriteTimeout because /reviews/:id/events streams heartbeats for the
	// whole batch (minutes) and the timeout would cut long streams.
	// Client abort governs the write side.
	httpServer := &http.Server{
		Addr:              address,
		Handler:           app.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	if err := httpServer.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

func workerCommand(python, workerPath, model, device string) []string {
	args := []string{python, workerPath, "--model", model}
	// "auto" defers to the pinned upstream default (cuda when torch sees a
	// GPU, else cpu) with AMP on; explicit cpu keeps today's deterministic
	// flags. AMP only engages on cuda (upstream autocast guard), so omitting
	// --no-use-amp on the cuda path is what unlocks mixed precision.
	if device != "auto" {
		args = append(args, "--device", device)
		if device == "cpu" {
			args = append(args, "--no-use-amp")
		}
	}
	return append(args, "--multipv", "5", "--temperature", "0", "--use-uci-history")
}

// validDevice gates MAIA3_DEVICE: auto (upstream default), cpu, or
// cuda with an optional index. Anything else fails fast at startup so a
// typo never boots workers that immediately crash on torch .to(device).
func validDevice(device string) bool {
	if device == "auto" || device == "cpu" || device == "cuda" {
		return true
	}
	if len(device) > 5 && device[:5] == "cuda:" {
		index := device[5:]
		if index == "" {
			return false
		}
		for _, digit := range index {
			if digit < '0' || digit > '9' {
				return false
			}
		}
		return true
	}
	return false
}

// parseIdleTimeout parses MAIA3_IDLE_TIMEOUT: a Go duration ("10m", "1h")
// after which an unused Maia worker process is stopped to free GPU memory.
// "0" (or negative, or empty) disables eviction; the caller supplies the
// default via getenv before calling.
func parseIdleTimeout(raw string) (time.Duration, error) {
	if raw == "" {
		return 0, nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil {
		return 0, err
	}
	if d < 0 {
		return 0, nil
	}
	return d, nil
}

// idleReaperInterval checks often enough to honor the timeout without
// waking constantly: half the timeout, clamped to [10s, 1m].
func idleReaperInterval(timeout time.Duration) time.Duration {
	interval := timeout / 2
	if interval < 10*time.Second {
		interval = 10 * time.Second
	}
	if interval > time.Minute {
		interval = time.Minute
	}
	return interval
}

// startIdleReaper stops Maia workers that outlived their idle timeout,
// freeing GPU memory until the next request cold-starts them. The sweep
// never interrupts running or queued work; it only unloads truly idle
// processes. Next inference pays a reload.
func startIdleReaper(pool *engine.EnginePool, timeout time.Duration) {
	interval := idleReaperInterval(timeout)
	log.Printf("maia idle unloader: timeout=%s interval=%s", timeout, interval)
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for range ticker.C {
			pool.SweepIdle(time.Now())
		}
	}()
}

func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
