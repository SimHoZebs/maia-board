package main

import (
	"strings"
	"testing"
	"time"
)

func TestParseFallbackModel(t *testing.T) {
	for raw, want := range map[string]string{"5m": "5m", "off": "off", "": "5m"} {
		got, err := parseFallbackModel(raw)
		if err != nil || got != want {
			t.Fatalf("parseFallbackModel(%q) = %q, %v; want %q", raw, got, err, want)
		}
	}
	for _, raw := range []string{"none", "79m", "OFF", "0"} {
		if _, err := parseFallbackModel(raw); err == nil {
			t.Fatalf("parseFallbackModel(%q) accepted", raw)
		}
	}
}
func TestParseWorkerCount(t *testing.T) {
	for raw, want := range map[string]int{"1": 1, "2": 2, "8": 8, "": 1} {
		got, err := parseWorkerCount(raw, "MAIA3_79M_WORKERS")
		if err != nil || got != want {
			t.Fatalf("parseWorkerCount(%q) = %v, %v; want %v", raw, got, err, want)
		}
	}
	for _, raw := range []string{"0", "-2", "two", "1.5", "1x"} {
		if _, err := parseWorkerCount(raw, "MAIA3_79M_WORKERS"); err == nil {
			t.Fatalf("parseWorkerCount(%q) accepted", raw)
		}
	}
}
func TestParseIdleTimeout(t *testing.T) {
	for raw, want := range map[string]time.Duration{"10m": 10 * time.Minute, "30s": 30 * time.Second, "1h": time.Hour, "0": 0, "": 0} {
		got, err := parseIdleTimeout(raw)
		if err != nil || got != want {
			t.Fatalf("parseIdleTimeout(%q) = %v, %v; want %v", raw, got, err, want)
		}
	}
	if _, err := parseIdleTimeout("ten minutes"); err == nil {
		t.Fatal("invalid duration accepted")
	}
	if got, err := parseIdleTimeout("-5m"); err != nil || got != 0 {
		t.Fatalf("negative must disable without error, got %v %v", got, err)
	}
}

func TestIdleReaperInterval(t *testing.T) {
	if got := idleReaperInterval(10 * time.Minute); got != time.Minute {
		t.Fatalf("10m interval = %v, want 1m", got)
	}
	if got := idleReaperInterval(30 * time.Second); got != 15*time.Second {
		t.Fatalf("30s interval = %v, want 15s", got)
	}
	if got := idleReaperInterval(time.Second); got != 10*time.Second {
		t.Fatalf("1s interval = %v, want 10s floor", got)
	}
}

func TestWorkerCommandDeviceArgs(t *testing.T) {
	join := func(args []string) string { return strings.Join(args, " ") }
	auto := join(workerCommand("python3", "/app/maia3_worker.py", "79m", "auto"))
	if strings.Contains(auto, "--device") || strings.Contains(auto, "amp") {
		t.Fatalf("auto command must defer to upstream defaults, got %q", auto)
	}
	cpu := join(workerCommand("python3", "/app/maia3_worker.py", "79m", "cpu"))
	if !strings.Contains(cpu, "--device cpu") || !strings.Contains(cpu, "--no-use-amp") {
		t.Fatalf("cpu command must pin cpu without AMP, got %q", cpu)
	}
	cuda := join(workerCommand("python3", "/app/maia3_worker.py", "79m", "cuda:0"))
	if !strings.Contains(cuda, "--device cuda:0") || strings.Contains(cuda, "no-use-amp") {
		t.Fatalf("cuda command must select the GPU with AMP on, got %q", cuda)
	}
	for _, device := range []string{"auto", "cpu", "cuda", "cuda:0"} {
		if !validDevice(device) {
			t.Fatalf("validDevice(%q) = false, want true", device)
		}
	}
	for _, device := range []string{"", "cud", "cuda:", "cuda:x", "gpu", "CUDA"} {
		if validDevice(device) {
			t.Fatalf("validDevice(%q) = true, want false", device)
		}
	}
}
