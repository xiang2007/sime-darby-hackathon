// Guessing hallways from a room's outline (shapeOf in web/index.html), for rooms measured from photos.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const a = html.indexOf("/* ---------- geometry ---------- */"), b = html.indexOf("/* ---------- stairs", a);
assert.ok(a >= 0 && b > a);
const { shapeOf } = new Function(`${html.slice(a, b)}; return {shapeOf};`)();

const rect = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];
const plus = (arm, span) => { const p = (span - arm) / 2, q = p + arm;
  return [[p, 0], [q, 0], [q, p], [span, p], [span, q], [q, q], [q, span], [p, span], [p, q], [0, q], [0, p], [p, p]]; };
// a 2 m corridor whose walls step in and out by 0.3 m every metre, like an outline measured from photos
const jagged = (w, L) => { const top = [], bot = []; for (let x = 0; x < L; x++) { const o = (x % 2) * 0.3; top.push([x, o], [x + 1, o]); bot.unshift([x, w + o], [x + 1, w + o]); } return [...top, ...bot]; };

test("long narrow outlines are corridors, with their width measured", () => {
  for (const [p, w] of [[rect(20, 2.4), 2.4], [jagged(2, 15), 2], [[[0, 0], [24, 0], [24, 14], [21.6, 14], [21.6, 2.4], [0, 2.4]], 2.4], [plus(2.4, 20), 2.4]]) {
    const g = shapeOf(p);
    assert.equal(g.kind, "corridor");
    assert.ok(Math.abs(g.width - w) <= 0.2, `width ${g.width} vs ${w}`);
  }
});

test("a big open area that branches out is a lobby", () => {
  assert.equal(shapeOf(plus(4, 20)).kind, "lobby");
});

test("ordinary rooms are left alone", () => {
  for (const p of [rect(5, 5), rect(20, 8), rect(8, 3), rect(16, 5), rect(30, 30)]) assert.equal(shapeOf(p).kind, null);
});
