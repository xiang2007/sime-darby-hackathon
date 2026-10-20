// Adding a worker map to the plan on the server (lib/mapimport.js), placed by GPS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeMap, fromLatLng, importNote } from "../lib/mapimport.js";
import { inside, llCentroid, loadCampus, mainBuilding } from "../lib/campus.js";
import * as V from "../lib/validate.js";

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
// A 20 × 2.4 m hallway with two 5 × 5 rooms off it, in the worker's own frame (starting at 0, 0)
const map = (ids = [null, null]) => V.mapResult({
  kind: "map", block: null, floor: null, length: 40,
  regions: [
    { id: null, type: "corridor", poly: rect(0, 5, 20, 7.4), doors: [{ e: 0, t: 0.2, w: 0.9 }, { e: 0, t: 0.7, w: 0.9 }] },
    { id: ids[0], type: "other", poly: rect(2, 0, 7, 5), doors: [{ e: 2, t: 0.5, w: 0.9 }] },
    { id: ids[1], type: "other", poly: rect(12, 0, 17, 5), doors: [{ e: 2, t: 0.5, w: 0.9 }] },
  ],
  path: [[1, 6], [5, 6], [5, 2], [5, 6], [15, 6], [15, 2], [15, 6], [19, 6]],
  scale: { source: "phone_height", confidence: "medium" }, images: { placed: 200, total: 210 }, notes: [], worker: { version: "1" },
});
const C = loadCampus(), main = mainBuilding(C);

test("the campus snapshot loads on the server", () => {
  assert.ok(C && C.buildings.length > 10);
  assert.ok(main && main.area > 1000);
});

test("first map on an empty plan: the block is placed roughly and the walk lands inside the building at the GPS fix", () => {
  const [lat, lng] = llCentroid(main.rings[0]);
  const { plan, summary } = mergeMap(null, map(), { _id: "7", block: "B", floor: 4, geo: { lat, lng, acc: 15 } });
  assert.equal(summary.placed, "gps");
  assert.equal(summary.placedBlock, true);
  assert.ok(plan.geo, "the block now has a map position");
  assert.deepEqual(plan.floors, [{ level: 4, name: "Level 4" }]);
  assert.deepEqual(plan.rooms.map(r => r.id), ["B-04-HALL", "B-04-R1", "B-04-R2"]);
  const ring = main.rings[0].slice(0, -1).map(([a, b]) => fromLatLng(a, b, plan.geo));
  const pts = plan.rooms.flatMap(r => r.poly);
  assert.ok(pts.filter(p => inside(p, ring)).length / pts.length > 0.9, "fits inside the building outline");
  assert.equal(summary.fit > 0.9, true);
  assert.doesNotThrow(() => V.plan(plan), "the merged plan passes the API's checks");
  assert.match(importNote("7", summary), /placed by the session's GPS/);
});

test("a second walk elsewhere goes where its GPS says, not on top of the first", () => {
  const [lat, lng] = llCentroid(main.rings[0]);
  const first = mergeMap(null, map(), { _id: "1", block: "B", floor: 4, geo: { lat, lng, acc: 10 } }).plan;
  // 25 m east of the first fix
  const east = lng + 25 / (111320 * Math.cos(lat * Math.PI / 180));
  const { plan, summary } = mergeMap(first, map(), { _id: "2", block: "B", floor: 4, geo: { lat, lng: east, acc: 10 } });
  assert.equal(summary.placed, "gps");
  assert.equal(summary.placedBlock, undefined, "the block keeps its position");
  const a = plan.rooms.find(r => r.id === "B-04-HALL"), b = plan.rooms.find(r => r.id === "B-04-HALL-2");
  assert.ok(a && b, "the second hallway gets its own ID");
  const cx = p => p.reduce((s, q) => s + q[0], 0) / p.length, cy = p => p.reduce((s, q) => s + q[1], 0) / p.length;
  const gap = Math.hypot(cx(b.poly) - cx(a.poly), cy(b.poly) - cy(a.poly));
  assert.ok(gap > 12 && gap < 40, `about 25 m apart (got ${gap.toFixed(1)} m)`);
});

test("rooms already on the plan with the same ID win over GPS", () => {
  const room = (id, poly) => ({ k: id, id, name: "", type: "lab", floor: 4, height: 3.2, poly, doors: [] });
  // the two rooms, already drawn 100 m away from the origin
  const plan0 = { block: "B", floors: [{ level: 4, name: "Level 4" }], rooms: [room("B-04-02", rect(102, 100, 107, 105)), room("B-04-05", rect(112, 100, 117, 105))] };
  const { plan, summary } = mergeMap(plan0, map(["B-04-02", "B-04-05"]), { _id: "3", block: "B", floor: 4, geo: { lat: 3.0556, lng: 101.7, acc: 20 } });
  assert.equal(summary.placed, "rooms");
  assert.deepEqual(summary.replaced, ["B-04-02", "B-04-05"]);
  assert.deepEqual(plan.rooms.find(r => r.id === "B-04-02").poly, rect(102, 100, 107, 105));
  assert.equal(plan.rooms.find(r => r.id === "B-04-02").type, "lab", "the type set by hand is kept");
  assert.equal(plan.geo, undefined, "no GPS needed, so the block isn't placed");
});

test("no GPS: beside the other rooms, as Import walk or map does", () => {
  const room = { k: "a", id: "B-04-01", name: "", type: "lab", floor: 4, height: 3.2, poly: rect(0, 0, 4, 4), doors: [] };
  const { plan, summary } = mergeMap({ block: "B", floors: [{ level: 4, name: "L4" }], rooms: [room] }, map(), { _id: "4", block: "B", floor: 4, geo: null });
  assert.equal(summary.placed, "beside");
  assert.ok(Math.min(...plan.rooms.filter(r => r.id !== "B-04-01").flatMap(r => r.poly.map(p => p[0]))) >= 6);
});

test("map result validation", () => {
  assert.throws(() => V.mapResult({ ...map(), kind: "walk" }), V.Invalid);
  assert.throws(() => V.mapResult({ ...map(), regions: [] }), V.Invalid);
  assert.throws(() => V.mapResult({ ...map(), regions: [{ type: "corridor", poly: [[0, 0], [1, 1]] }] }), V.Invalid);
  assert.throws(() => V.mapResult({ ...map(), regions: [{ type: "corridor", poly: rect(0, 0, 1, 1), doors: [{ e: 9, t: 0.5, w: 0.9 }] }] }), V.Invalid);
  const m = V.mapResult({ ...map(), extra: 1, regions: [{ id: "B-04-02", type: "lab", poly: rect(0, 0, 1, 1), evil: 1 }] });
  assert.equal(m.extra, undefined);
  assert.deepEqual(Object.keys(m.regions[0]).sort(), ["area", "doors", "id", "partial", "poly", "type", "width"]);
  assert.equal(m.regions[0].type, "other");
});

test("map session validation", () => {
  const s = V.mapSession({ by: "Ana", block: "b", floor: 4, bytes: 150e6, type: "video/mp4", name: "floor.mp4", geo: { lat: 3.05531234, lng: 101.70067, acc: 12.4 } });
  assert.deepEqual([s.block, s.floor, s.bytes, s.type], ["B", 4, 150e6, "video/mp4"]);
  assert.deepEqual(s.detail.geo, { lat: 3.05531, lng: 101.70067, acc: 12 });
  assert.throws(() => V.mapSession({ floor: 4, bytes: 10, type: "image/jpeg" }), V.Invalid);
  assert.throws(() => V.mapSession({ floor: 4, bytes: 2e9, type: "video/mp4" }), V.Invalid);
  assert.throws(() => V.mapSession({ floor: "4", bytes: 10, type: "video/mp4" }), V.Invalid);
});
