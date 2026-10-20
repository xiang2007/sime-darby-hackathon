// Adding a room measured from photos (worker.py, Live camera) to the plan on the server (mergeScan in lib/mapimport.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeScan, scanNote, snapShift, guessType, fromLatLng, Skip } from "../lib/mapimport.js";
import { inside, llCentroid, loadCampus, mainBuilding } from "../lib/campus.js";
import * as V from "../lib/validate.js";

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const room = (id, poly, extra = {}) => ({ k: id, id, name: "", type: "other", floor: 3, height: 3.2, poly, doors: [], ...extra });
const scan = (extra = {}) => V.reconResult({
  poly: rect(0, 0, 6, 4), size: [6, 4], area: 24, height: 2.95, scale: { source: "marker", confidence: "high", views: 3 },
  images: { placed: 30, total: 32 }, points: 5000, aligned: false, notes: [], marker: [3, 4], wallPoints: [],
  cameras: [[2, 2], [3, 2], [4, 2]], worker: { version: "3" }, ...extra,
});
const cx = p => p.reduce((s, q) => s + q[0], 0) / p.length, cy = p => p.reduce((s, q) => s + q[1], 0) / p.length;
const C = loadCampus(), main = mainBuilding(C);

test("walls a little apart are lined up, and it won't push into the room next door", () => {
  // 0.4 m short of the room on the left, 0.3 m below the corridor's wall
  const s = snapShift([rect(10.4, 5.3, 16, 10)], [rect(4, 5, 10, 10), rect(0, 2, 30, 5)]);
  assert.deepEqual(s.shift, [-0.4, -0.3]);
  assert.equal(s.walls, 2);
  // A narrow room 0.4 m to the right, with a bigger one behind it: lining up with the bigger room's wall
  // (more wall in common) would cover the narrow one, so the narrow one's near wall is used
  assert.deepEqual(snapShift([rect(0, 0, 4, 4)], [rect(4.4, 0, 5.2, 4), rect(5.2, 0, 9, 4)]).shift, [0.4, 0]);
  assert.equal(snapShift([rect(0, 0, 4, 4)], [rect(20, 0, 24, 4)]).walls, 0, "nothing near enough");
});

test("a drawn room gets the measured outline, lined up with the walls beside it", () => {
  // The worker already put the scan over B-03-02 (aligned), 0.25 m off the corridor wall at y = 5
  const plan0 = { block: "B", floors: [{ level: 3, name: "L3" }], rooms: [
    room("B-03-02", rect(10, 5, 16, 9), { type: "lab", doors: [{ e: 0, t: 0.5, w: 0.9 }] }),
    room("B-03-HALL", rect(0, 2, 30, 5), { type: "corridor" }),
  ] };
  const s = scan({ aligned: true, match: 0.82, poly: rect(10, 5.25, 16.1, 9.25), marker: [13, 5.25] });
  const { plan, summary } = mergeScan(plan0, s, { _id: "12", block: "B", floor: 3, room: "B-03-02", geo: null });
  assert.equal(summary.action, "replaced");
  assert.equal(summary.placed, "room");
  const r = plan.rooms.find(x => x.id === "B-03-02");
  assert.deepEqual(r.poly, rect(10, 5, 16.1, 9), "moved 0.25 m onto the corridor wall");
  assert.equal(r.height, 2.95);
  assert.equal(r.type, "lab", "the type set by hand is kept");
  assert.equal(r.doors.length, 1);
  assert.equal(r.doors[0].e, 0, "the door stays on the corridor side");
  assert.ok(summary.snapped >= 1);
  assert.deepEqual(summary.xf, { k: 0, t: [0, -0.25] });
  assert.doesNotThrow(() => V.plan(plan));
  assert.match(scanNote("12", summary), /new outline for B-03-02 .*82% the same.*lined up/);
});

test("a measurement that doesn't look like the drawn room is left off", () => {
  const plan0 = { block: "B", floors: [{ level: 3, name: "L3" }], rooms: [room("B-03-02", rect(10, 5, 30, 25))] };
  assert.throws(() => mergeScan(plan0, scan({ aligned: true, match: 0.1, poly: rect(10, 5, 14, 8) }), { _id: "1", floor: 3, room: "B-03-02" }), Skip);
});

test("drawn room, but the worker didn't line it up: turned and moved onto it here", () => {
  const plan0 = { block: "B", floors: [{ level: 3, name: "L3" }], rooms: [room("B-03-02", rect(50, 50, 54, 56))] };
  const { plan, summary } = mergeScan(plan0, scan(), { _id: "2", floor: 3, room: "B-03-02" });
  assert.equal(summary.turned % 180, 90, "6 × 4 turned to fit 4 × 6");
  assert.ok(summary.match > 0.9);
  const r = plan.rooms[0];
  assert.ok(Math.abs(cx(r.poly) - 52) < 0.01 && Math.abs(cy(r.poly) - 53) < 0.01);
});

test("a new room goes where its GPS says, inside the building, with its door onto the hallway", () => {
  const [lat, lng] = llCentroid(main.rings[0]);
  // place a hallway first, so the plan has a map position
  const first = mergeScan(null, scan({ poly: rect(0, 0, 30, 2.4), marker: null, cameras: [[15, 1.2]] }),
    { _id: "5", block: "B", floor: 3, room: "", geo: { lat, lng, acc: 12 } });
  assert.equal(first.summary.placed, "gps");
  assert.equal(first.summary.placedBlock, true);
  assert.equal(first.plan.rooms[0].type, "corridor", "a long narrow outline is a hallway");
  assert.equal(first.plan.rooms[0].id, "B-03-01");
  const hall = first.plan.rooms[0].poly;
  // the room was photographed from about 4 m beside the hallway's middle
  const north = lat + 4 / 111320;
  const { plan, summary } = mergeScan(first.plan, scan(), { _id: "6", block: "B", floor: 3, room: "B-03-07", geo: { lat: north, lng, acc: 8 } });
  assert.equal(summary.action, "added");
  assert.equal(summary.placedBlock, undefined);
  const r = plan.rooms.find(x => x.id === "B-03-07");
  assert.ok(r, "added with the ID from the session");
  assert.equal(r.height, 2.95);
  assert.equal(r.doors.length, 1, "a door where the marker was");
  const ring = main.rings[0].slice(0, -1).map(([a, b]) => fromLatLng(a, b, plan.geo));
  assert.ok(r.poly.every(p => inside([p[0] + Math.sign(cx(r.poly) - p[0]) * 0.1, p[1] + Math.sign(cy(r.poly) - p[1]) * 0.1], ring)), "inside the building");
  const e = r.doors[0].e, a = r.poly[e], b = r.poly[(e + 1) % 4], d = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const [hx0, hy0, hx1, hy1] = [Math.min(...hall.map(p => p[0])), Math.min(...hall.map(p => p[1])), Math.max(...hall.map(p => p[0])), Math.max(...hall.map(p => p[1]))];
  const gap = Math.max(hx0 - d[0], d[0] - hx1, hy0 - d[1], d[1] - hy1, 0);
  assert.ok(gap <= 1.0, `the door opens onto the hallway (${gap.toFixed(2)} m away)`);
  assert.doesNotThrow(() => V.plan(plan));
});

test("no GPS and no drawn room: beside the other rooms", () => {
  const plan0 = { block: "B", floors: [{ level: 3, name: "L3" }], rooms: [room("B-03-01", rect(0, 0, 5, 5))] };
  const { plan, summary } = mergeScan(plan0, scan(), { _id: "7", floor: 3, room: "B-03-01", geo: null });
  // B-03-01 is drawn, so that's replaced; a different ID is added beside
  assert.equal(summary.action, "replaced");
  const two = mergeScan(plan0, scan(), { _id: "8", floor: 3, room: "B-03-09", geo: null });
  assert.equal(two.summary.placed, "beside");
  assert.ok(Math.min(...two.plan.rooms.find(r => r.id === "B-03-09").poly.map(p => p[0])) >= 5);
  assert.ok(plan);
});

test("room types from the outline", () => {
  assert.equal(guessType(rect(0, 0, 20, 2.4)), "corridor");
  assert.equal(guessType(rect(0, 0, 6, 4)), "other");
});
