#!/usr/bin/env node
// Build the server-side opening book from the pinned lichess-org/chess-openings
// source. Upstream TSVs carry (eco, name, pgn); EPD position keys are derived
// here with the same chess.js semantics the game pipeline uses, so a row that
// does not replay to a single legal line fails the build instead of shipping a
// corrupt entry. Runtime lookup lives in backend/openings_lookup.py
// (python-chess); the EPD contract both sides share is: FEN without move
// counters, en-passant square only when a capture is actually legal.
//
// Usage (from frontend/, needs its node_modules for chess.js):
//   node scripts/build-openings-table.mjs            # regenerate backend/openings_table.json
//   node scripts/build-openings-table.mjs --check    # CI: exit 1 when the artifact is stale
//
// Network: downloads a.tsv-e.tsv at PINNED_SHA (~3800 rows total).

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const PINNED_SHA = '4b8622759e7ae6f93f011cc6c83a3823401ab45e';
const PINNED_DATE = '2026-08-04';
const VOLUMES = ['a', 'b', 'c', 'd', 'e'];
const OUT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'backend', 'openings_table.json');

// EPD key: FEN without move counters, en-passant square only when a capture is
// actually legal. chess.js already blanks stale squares; the flags check covers
// the remaining pin-illegal case. Must stay identical to epd_key() in
// backend/openings_lookup.py.
function epdKey(fen) {
  const normalized = new Chess(fen).fen().split(' ');
  let ep = normalized[3];
  if (ep !== '-') {
    const probe = new Chess(fen);
    const hasEp = probe.moves({ verbose: true }).some((m) => m.flags.includes('e'));
    if (!hasEp) ep = '-';
  }
  return `${normalized[0]} ${normalized[1]} ${normalized[2]} ${ep}`;
}

async function fetchTsv(volume) {
  const url = `https://raw.githubusercontent.com/lichess-org/chess-openings/${PINNED_SHA}/${volume}.tsv`;
  const response = await fetch(url, { headers: { 'User-Agent': 'maia-board-build' } });
  if (!response.ok) throw new Error(`fetch ${url} failed (${response.status})`);
  return response.text();
}

async function build() {
  // EPD -> { eco, name, ply }. Duplicate EPDs (transposed paths to one board)
  // keep the most specific name; ties keep the deeper line.
  const table = new Map();
  let rows = 0;
  let collisions = 0;
  const failures = [];
  for (const volume of VOLUMES) {
    const text = await fetchTsv(volume);
    const lines = text.split('\n');
    for (let index = 1; index < lines.length; index++) {
      const line = lines[index].trimEnd();
      if (!line) continue;
      const fields = line.split('\t');
      if (fields.length !== 3) {
        failures.push(`${volume}.tsv:${index + 1}: expected 3 tab fields, got ${fields.length}`);
        continue;
      }
      const [eco, name, pgn] = fields;
      rows++;
      let game;
      try {
        game = new Chess();
        game.loadPgn(pgn);
      } catch (error) {
        failures.push(`${volume}.tsv:${index + 1} (${eco} ${name}): PGN replay failed: ${error.message}`);
        continue;
      }
      const history = game.history({ verbose: true });
      const ply = history.length;
      if (!ply) {
        failures.push(`${volume}.tsv:${index + 1} (${eco} ${name}): empty line`);
        continue;
      }
      const key = epdKey(game.fen());
      const prev = table.get(key);
      if (prev) {
        collisions++;
        if (name.length > prev.name.length || (name.length === prev.name.length && ply > prev.ply)) {
          table.set(key, { eco, name, ply });
        }
      } else {
        table.set(key, { eco, name, ply });
      }
    }
  }
  return { table, rows, collisions, failures };
}

function render(table, rows, collisions) {
  const positions = {};
  for (const key of [...table.keys()].sort()) {
    const { eco, name } = table.get(key);
    positions[key] = [eco, name];
  }
  return JSON.stringify({
    sha: PINNED_SHA,
    date: PINNED_DATE,
    rows,
    collisions,
    // CC0 public-domain dedication, see https://github.com/lichess-org/chess-openings.
    positions,
  });
}

const check = process.argv.includes('--check');
const { table, rows, collisions, failures } = await build();
if (failures.length) {
  console.error(`build-openings-table: ${failures.length} unparseable rows (showing 20):`);
  for (const failure of failures.slice(0, 20)) console.error(`  ${failure}`);
  process.exit(1);
}
if (table.size < 3000) {
  console.error(`build-openings-table: only ${table.size} positions from ${rows} rows — upstream truncation?`);
  process.exit(1);
}
const output = render(table, rows, collisions);
if (check) {
  const current = readFileSync(OUT_PATH, 'utf8');
  if (current !== output) {
    console.error('build-openings-table: backend/openings_table.json is stale — run node scripts/build-openings-table.mjs');
    process.exit(1);
  }
  console.log(`build-openings-table: fresh (${table.size} positions, ${rows} rows, ${collisions} collisions)`);
} else {
  writeFileSync(OUT_PATH, output);
  console.log(`build-openings-table: wrote ${OUT_PATH} (${table.size} positions, ${rows} rows, ${collisions} collisions)`);
}
