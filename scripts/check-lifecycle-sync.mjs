#!/usr/bin/env node
// check-lifecycle-sync.mjs — keeps lifecycle-visualization.html honest.
// Verifies spec/lifecycle-manifest.json three ways:
//   1. manifest -> code: every anchor (file + patterns) still matches the repo.
//   2. manifest -> docs/viz: every viz token appears in the HTML; every signal
//      appears in AGENTS.md's observability table.
//   3. reverse: every API path literal registered in the router file
//      (Huma Path values + Chi mounts, see manifest reverse.route_pattern)
//      is covered by the manifest, so new endpoints/engines cannot land silently.
// Run from the repo root: node scripts/check-lifecycle-sync.mjs (wired into verify.sh).
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
let pass = 0;
let fail = 0;
const failures = [];
function check(cond, msg) {
  if (cond) { pass++; }
  else { fail++; failures.push(msg); console.error(`FAIL  ${msg}`); }
}
function read(rel) { return readFileSync(join(ROOT, rel), 'utf8'); }
function codeMatches(file, patterns) {
  if (!existsSync(join(ROOT, file))) return { ok: false, missing: `file ${file}` };
  const src = read(file);
  for (const p of patterns) {
    if (!new RegExp(p).test(src)) return { ok: false, missing: `/${p}/ in ${file}` };
  }
  return { ok: true };
}

const man = JSON.parse(read('spec/lifecycle-manifest.json'));
const html = read(man.viz);
const agents = read('AGENTS.md');

// 1+2. routes (server anchors live in the router file named by the manifest)
const routesFile = man.reverse.routes_file;
for (const r of man.routes) {
  const s = codeMatches(routesFile, [r.server_anchor]);
  check(s.ok, `route ${r.id}: server anchor missing: ${s.missing ?? r.server_anchor}`);
  if (r.lane) {
    const l = codeMatches(r.lane.file, r.lane.patterns);
    check(l.ok, `route ${r.id}: lane anchor missing: ${l.missing ?? r.lane.patterns.join(',')}`);
  }
  for (const t of r.viz ?? []) check(html.includes(t), `route ${r.id}: viz token absent from ${man.viz}: ${JSON.stringify(t)}`);
}
// 1+2. frontend components
for (const c of man.frontend) {
  const m = codeMatches(c.file, c.patterns);
  check(m.ok, `frontend ${c.id}: code anchor missing: ${m.missing ?? c.patterns.join(',')}`);
  for (const t of c.viz ?? []) check(html.includes(t), `frontend ${c.id}: viz token absent: ${JSON.stringify(t)}`);
}
// 1+2. workers
for (const w of man.workers) {
  const m = codeMatches(w.file, w.patterns);
  check(m.ok, `worker ${w.id}: code anchor missing: ${m.missing ?? w.patterns.join(',')}`);
  for (const t of w.viz ?? []) check(html.includes(t), `worker ${w.id}: viz token absent: ${JSON.stringify(t)}`);
}
// 1+2. signals (+ AGENTS.md contract)
for (const s of man.signals) {
  const m = codeMatches(s.code.file, s.code.patterns);
  check(m.ok, `signal ${s.id}: not emitted in code: ${m.missing ?? s.code.patterns.join(',')}`);
  check(agents.includes(s.agents), `signal ${s.id}: absent from AGENTS.md observability table: ${JSON.stringify(s.agents)}`);
  for (const t of s.viz ?? []) check(html.includes(t), `signal ${s.id}: viz token absent: ${JSON.stringify(t)}`);
}
// 1+2. limits
for (const l of man.limits) {
  const m = codeMatches(l.code.file, l.code.patterns);
  check(m.ok, `limit ${l.id}: code anchor missing: ${m.missing ?? l.code.patterns.join(',')}`);
  for (const t of l.viz ?? []) check(html.includes(t), `limit ${l.id}: viz token absent: ${JSON.stringify(t)}`);
}
// 3a. reverse: all registered routes covered
{
  const serverSrc = read(man.reverse.routes_file);
  const found = [...serverSrc.matchAll(new RegExp(man.reverse.route_pattern, 'g'))].map((m) => m[1]);
  const covered = new Set(man.routes.flatMap((r) => r.covers));
  const ignored = new Set(man.reverse.ignore_paths);
  check(found.length > 0, `reverse routes: no HandleFunc routes parsed from ${man.reverse.routes_file}`);
  for (const p of found) {
    check(covered.has(p) || ignored.has(p), `reverse routes: ${p} registered in code but in neither manifest nor ignore_paths`);
  }
  for (const r of man.routes) {
    for (const p of r.covers) check(found.includes(p), `reverse routes: manifest covers ${p} but it is not registered in ${man.reverse.routes_file}`);
  }
}
// 3b. reverse: all worker adapters covered
{
  const files = readdirSync(join(ROOT, man.reverse.workers_dir))
    .filter((f) => f.endsWith(man.reverse.worker_suffix) && !f.startsWith(man.reverse.worker_ignore_prefix));
  const coveredFiles = new Set(man.workers.map((w) => w.file.split('/').pop()));
  check(files.length > 0, `reverse workers: no adapters found in ${man.reverse.workers_dir}`);
  for (const f of files) check(coveredFiles.has(f), `reverse workers: ${f} exists but has no manifest entry`);
}

// 3c. spec: every manifest route cover appears in the generated spec, so a
// route that is registered but missing from spec/openapi.yaml fails loudly
// instead of drifting silently (plain-Chi paths included: they are declared
// in code in registerOps).
{
  const spec = read('spec/openapi.yaml');
  for (const r of man.routes) {
    for (const p of r.covers) check(spec.includes(`\n  ${p}:`), `spec: manifest cover ${p} missing from spec/openapi.yaml`);
  }
}


console.log(`\nlifecycle-sync: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} checks, ${fail} failures)`);
process.exit(fail === 0 ? 0 : 1);
