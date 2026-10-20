// The campus outline code in web/index.html: reading Overpass JSON and snapping a plan onto a building footprint.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const cut = (from, to) => { const a = html.indexOf(from), b = html.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return html.slice(a, b); };
const src = [
  cut("/* ---------- geometry ---------- */", "/* ---------- stairs"),
  cut("const M_PER_DEG=", "let navWatch"),
  cut("/* osm:begin */", "/* osm:end */"),
].join("\n");
const C = new Function("S", `${src}; return {parseCampus, fitToFootprint, joinRings, toLatLng, area};`)({ plan: { rooms: [] } });

// An L-shaped block: a 30 m corridor along the top and a wing down the right-hand side
const rooms = [
  { poly: [[0, 0], [30, 0], [30, 3], [0, 3]] },
  { poly: [[27, 3], [30, 3], [30, 20], [27, 20]] },
];
const outline = [[0, 0], [30, 0], [30, 20], [27, 20], [27, 3], [0, 3]];
const truth = { x: 10, y: 5, lat: 3.0553, lng: 101.7007, rot: 30 };
const ring = g => { const r = g.map(p => C.toLatLng(p, truth)); return [...r, r[0]].map(([lat, lon]) => ({ lat, lon })); };
const box = (s, w, n, e) => [{ lat: s, lon: w }, { lat: s, lon: e }, { lat: n, lon: e }, { lat: n, lon: w }, { lat: s, lon: w }];

const osm = { elements: [
  { type: "way", id: 1, tags: { amenity: "university", name: "Asia Pacific University (APU)" }, geometry: box(3.053, 101.698, 3.058, 101.703) },
  { type: "way", id: 2, tags: { landuse: "education", name: "Some school" }, geometry: box(3.040, 101.690, 3.045, 101.695) },
  { type: "way", id: 3, tags: { building: "university", name: "Block B", "building:levels": "6" }, geometry: ring(outline) },
  { type: "way", id: 4, tags: { building: "yes" }, geometry: box(3.0600, 101.7050, 3.0601, 101.7051) },
  { type: "way", id: 5, tags: { highway: "footway", covered: "yes" }, geometry: [{ lat: 3.054, lon: 101.699 }, { lat: 3.055, lon: 101.700 }] },
  { type: "node", id: 6, lat: 3.0553, lon: 101.7007, tags: { entrance: "main" } },
  { type: "relation", id: 7, tags: { building: "yes", name: "Split" }, members: [
    { type: "way", role: "outer", geometry: [{ lat: 3.054, lon: 101.699 }, { lat: 3.054, lon: 101.6992 }, { lat: 3.0542, lon: 101.6992 }] },
    { type: "way", role: "outer", geometry: [{ lat: 3.054, lon: 101.699 }, { lat: 3.0542, lon: 101.699 }, { lat: 3.0542, lon: 101.6992 }] },
  ] },
] };

test("parses the campus, buildings, paths and entrances", () => {
  const c = C.parseCampus(osm);
  assert.equal(c.campus.id, "way/1", "the area named like APU is the campus");
  assert.equal(c.others.length, 1);
  assert.deepEqual(c.buildings.map(b => b.id), ["way/3", "way/4", "relation/7"]);
  assert.deepEqual(c.buildings.map(b => b.inCampus), [true, false, true]);
  assert.equal(c.buildings[0].levels, 6);
  assert.equal(c.paths.length, 1); assert.equal(c.paths[0].covered, true);
  assert.equal(c.entrances[0].kind, "main");
  assert.equal(c.buildings[2].rings.length, 1, "multipolygon members join into one ring");
  assert.equal(c.buildings[2].rings[0].length, 5);
  const fp = c.buildings[0].area, real = C.area(outline);
  assert.ok(Math.abs(fp - real) / real < 0.01, `footprint area ${fp.toFixed(1)} vs ${real}`);
});

test("snaps the plan onto its footprint, picking the right one of four turns", () => {
  const b = C.parseCampus(osm).buildings[0];
  const f = C.fitToFootprint(rooms, b);
  assert.ok(Math.abs(f.rot - truth.rot) < 1, `rot ${f.rot}`);
  assert.ok(f.iou > 0.9, `overlap ${f.iou}`);
  // Every corner of the plan lands within half a metre of where it really is
  for (const p of outline) {
    const [a, c] = [C.toLatLng(p, f), C.toLatLng(p, truth)];
    const d = Math.hypot((a[0] - c[0]) * 111320, (a[1] - c[1]) * 111320 * Math.cos(c[0] * Math.PI / 180));
    assert.ok(d < 0.5, `corner ${p} is ${d.toFixed(2)} m off`);
  }
});

test("plan turned the other way still snaps", () => {
  const g = { ...truth, rot: -120 };
  const r = outline.map(p => C.toLatLng(p, g));
  const b = { rings: [[...r, r[0]]] };
  const f = C.fitToFootprint(rooms, b);
  assert.ok(Math.abs(f.rot - -120) < 1, `rot ${f.rot}`);
});
