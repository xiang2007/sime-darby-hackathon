// Adds a floor map from the worker (worker.py --map, run on an uploaded walk video) to the plan, the way
// Floor plan → Walks → Import walk or map does in web/index.html (mapPlan and importMap), but on the server,
// as soon as the worker reports back.
//
// Where it goes, best first:
//  1. Two or more rooms on the map are already on the floor with the same ID (read from their door signs) and laid
//     out the same way (within 1.5 m): the map is turned in 90° steps and moved onto them.
//  2. The session has a GPS fix: the middle of the walk goes where the GPS says, then it's nudged (within the GPS
//     accuracy, up to 40 m) and turned in 90° steps so it fits inside the building outline from OpenStreetMap
//     without covering rooms already on the floor. If the block isn't on the map yet, it's placed roughly first,
//     the same way the Floor plan backdrop does it: the plan's centre at the main building's centre, walls square
//     to the grid.
//  3. Otherwise: an empty floor's origin, or beside the rooms already on the floor.
import { M_PER_DEG, inside, llCentroid, llInside, loadCampus, mainBuilding } from "./campus.js";

const DOOR_W = 0.9;
const r2 = v => +v.toFixed(2);
const centroid = p => { let x = 0, y = 0; p.forEach(q => { x += q[0]; y += q[1]; }); return [x / p.length, y / p.length]; };
const bbox = p => { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; p.forEach(([x, y]) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }); return [x0, y0, x1, y1]; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const rot = (p, k) => { let [x, y] = p; for (let i = 0; i < k; i++) [x, y] = [-y, x]; return [x, y]; };
const uid = () => Math.random().toString(36).slice(2, 10).padEnd(8, "0");

/* plan.geo = {x, y, lat, lng, rot}: plan point (x, y) sits at (lat, lng), turned rot degrees clockwise (as in web/index.html). */
export function fromLatLng(lat, lng, g) {
  const t = g.rot * Math.PI / 180, n = (lat - g.lat) * M_PER_DEG, e = (lng - g.lng) * M_PER_DEG * Math.cos(g.lat * Math.PI / 180);
  const e0 = e * Math.cos(t) - n * Math.sin(t), n0 = e * Math.sin(t) + n * Math.cos(t);
  return [g.x + e0, g.y - n0];
}
function dominantAngle(segs) {
  let c = 0, s = 0;
  segs.forEach(([a, b]) => { const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy), t = Math.atan2(dy, dx); c += L * Math.cos(4 * t); s += L * Math.sin(4 * t); });
  return Math.atan2(s, c) / 4;
}
const square45 = d => ((d % 90) + 135) % 90 - 45;
const ringSegs = p => p.map((q, i) => [q, p[(i + 1) % p.length]]);

/** The rough frame the Floor plan uses before the block is placed: plan centre at the main building's centre. */
export function roughFrame(plan, campus, gps) {
  const pts = (plan.rooms || []).flatMap(r => r.poly), b = pts.length ? bbox(pts) : [0, 0, 0, 0];
  const c = [r2((b[0] + b[2]) / 2), r2((b[1] + b[3]) / 2)], main = mainBuilding(campus);
  if (!main) return { x: c[0], y: c[1], lat: +gps.lat.toFixed(7), lng: +gps.lng.toFixed(7), rot: 0 };
  const ll0 = llCentroid(main.rings[0]), k = M_PER_DEG * Math.cos(ll0[0] * Math.PI / 180);
  const F = main.rings.map(r => r.slice(0, -1).map(([lat, lng]) => [(lng - ll0[1]) * k, (lat - ll0[0]) * M_PER_DEG]));
  const turn = square45(-dominantAngle(F.flatMap(ringSegs)) * 180 / Math.PI);
  return { x: c[0], y: c[1], lat: +ll0[0].toFixed(7), lng: +ll0[1].toFixed(7), rot: +turn.toFixed(2) };
}

/** The building around a GPS fix (or the nearest one within 60 m), as an open ring in plan metres. */
function buildingAt(gps, g, campus) {
  if (!campus) return null;
  const ll = [gps.lat, gps.lng], kx = M_PER_DEG * Math.cos(ll[0] * Math.PI / 180);
  const metres = (a, b) => Math.hypot((a[1] - b[1]) * kx, (a[0] - b[0]) * M_PER_DEG);
  const near = campus.buildings.map(b => ({ b, d: llInside(ll, b.rings[0]) ? 0 : Math.min(...b.rings[0].map(p => metres(p, ll))) }))
    .filter(x => x.d <= 60).sort((a, b) => a.d - b.d || a.b.area - b.b.area)[0];
  if (!near) return null;
  return { id: near.b.id, name: near.b.name, ring: near.b.rings[0].slice(0, -1).map(([lat, lng]) => fromLatLng(lat, lng, g)) };
}

/** Points that stand for the map's floor space: each outline's corners, edge midpoints and centre. */
const samplePoints = regions => regions.flatMap(r => [...r.poly, ...r.poly.map((p, i) => { const q = r.poly[(i + 1) % r.poly.length]; return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]; }), centroid(r.poly)]);

/** Turn (k × 90°) and move the map so its middle is near the GPS fix and it fits the building without covering other rooms. */
export function placeByGps(regions, path, P, acc, building, others) {
  const S = samplePoints(regions), c = path?.length ? centroid(path) : (b => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2])(bbox(S));
  const R = Math.max(5, Math.min(40, acc || 20)), step = R > 20 ? 2 : 1;
  const ob = others.map(p => ({ p, b: bbox(p) }));
  const inOther = q => ob.some(o => q[0] >= o.b[0] && q[0] <= o.b[2] && q[1] >= o.b[1] && q[1] <= o.b[3] && inside(q, o.p));
  if (!building && !others.length) return { k: 0, t: [P[0] - c[0], P[1] - c[1]], fit: null, off: 0 };
  let best = null;
  for (let k = 0; k < 4; k++) {
    const Sk = S.map(p => rot(p, k)), ck = rot(c, k);
    for (let dx = -R; dx <= R; dx += step) for (let dy = -R; dy <= R; dy += step) {
      const off = Math.hypot(dx, dy); if (off > R) continue;
      const t = [P[0] + dx - ck[0], P[1] + dy - ck[1]];
      let fit = 0, clash = 0;
      for (const p of Sk) { const q = [p[0] + t[0], p[1] + t[1]]; if (building && inside(q, building)) fit++; if (others.length && inOther(q)) clash++; }
      const score = (building ? fit / Sk.length : 1) - clash / Sk.length - 0.002 * off - 0.0001 * k;
      if (!best || score > best.score) best = { k, t, score, fit: building ? fit / Sk.length : null, off };
    }
  }
  return best;
}

function cleanRegions(map) {
  return map.regions.map(r => ({
    id: r.id || null, type: ["corridor", "lobby"].includes(r.type) ? r.type : "other", poly: r.poly, partial: !!r.partial,
    doors: r.doors.filter(d => d.e < r.poly.length).map(d => ({ e: d.e, t: Math.max(0, Math.min(1, d.t)), w: Math.max(0.3, Math.min(5, d.w || DOOR_W)) })),
  }));
}

/**
 * Add the map to a copy of the plan. session: {_id, block, floor, geo}. Returns {plan, summary}.
 * campus defaults to the deployed OpenStreetMap snapshot; pass null to go without.
 */
export function mergeMap(planIn, map, session, { campus = loadCampus() } = {}) {
  const plan = planIn ? JSON.parse(JSON.stringify({ block: planIn.block || "", floors: planIn.floors || [], rooms: planIn.rooms || [], ...(planIn.geo ? { geo: planIn.geo } : {}) }))
    : { block: "", floors: [], rooms: [] };
  const fl = Number.isInteger(session.floor) ? session.floor : Number.isInteger(map.floor) ? map.floor : 0;
  if (!plan.block) plan.block = String(session.block || map.block || "").trim().toUpperCase().slice(0, 8);
  const floorRooms = plan.rooms.filter(r => r.floor === fl);
  const regions = cleanRegions(map);
  const here = new Map(floorRooms.map(r => [r.id, r])), match = regions.filter(r => r.id && here.has(r.id));

  // 1. Line up with rooms already on the plan
  let best = null, how = null, extra = {};
  if (match.length > 1) for (let k = 0; k < 4; k++) {
    const A = match.map(r => rot(centroid(r.poly), k)), B = match.map(r => centroid(here.get(r.id).poly));
    const t = [0, 1].map(i => B.reduce((s, b, j) => s + b[i] - A[j][i], 0) / B.length), err = A.reduce((s, a, j) => s + dist([a[0] + t[0], a[1] + t[1]], B[j]), 0) / A.length;
    if (err <= 1.5 && (!best || err < best.err)) best = { k, t, err };
  }
  if (best) how = "rooms";
  const others = floorRooms.filter(r => !match.some(m => m.id === r.id)).map(r => r.poly);

  // 2. GPS
  const gps = session.geo;
  if (!best && gps && Number.isFinite(gps.lat) && Number.isFinite(gps.lng) && (gps.acc == null || gps.acc <= 100)) {
    let g = plan.geo;
    if (!g) { g = roughFrame(plan, campus, gps); plan.geo = g; extra.placedBlock = true; }
    const P = fromLatLng(gps.lat, gps.lng, g), B = buildingAt(gps, g, campus);
    const p = placeByGps(regions, map.path, P, gps.acc, B?.ring || null, others);
    best = { k: p.k, t: p.t }; how = "gps";
    extra = { ...extra, building: B ? (B.name || B.id) : null, fit: p.fit == null ? null : +p.fit.toFixed(2), moved: +p.off.toFixed(1) };
  }

  // 3. Beside the other rooms
  if (!best) {
    const [x0, y0] = bbox(regions.flatMap(r => r.poly));
    best = { k: 0, t: others.length ? [bbox(others.flat())[2] + 2 - x0, bbox(others.flat())[1] - y0] : [-x0, -y0] };
    how = others.length ? "beside" : "origin";
  }
  const move = q => q.map(p => { const [x, y] = rot(p, best.k); return [r2(x + best.t[0]), r2(y + best.t[1])]; });

  if (!plan.floors.some(f => f.level === fl)) plan.floors.push({ level: fl, name: "Level " + fl });
  const ids = new Set(plan.rooms.map(r => r.id));
  const uniqueId = id => { let x = id, i = 2; while (ids.has(x)) x = id + "-" + (i++); ids.add(x); return x; };
  const pre = `${plan.block || "X"}-${String(fl).padStart(2, "0")}`, added = [], replaced = [], partial = [];
  let n = 0;
  for (const r of regions) {
    const poly = move(r.poly), old = r.id && here.get(r.id);
    if (old) { old.poly = poly; old.doors = r.doors; if (old.type === "other") old.type = r.type; replaced.push(old.id); }
    else {
      const id = uniqueId(r.id || (r.type === "other" ? `${pre}-R${++n}` : `${pre}-${r.type === "lobby" ? "LOBBY" : "HALL"}`));
      plan.rooms.push({ k: uid(), id, name: "", type: r.type, floor: fl, height: 3.2, poly, doors: r.doors });
      added.push(id);
    }
    if (r.partial) partial.push(r.id || "one room");
  }
  const halls = regions.filter(r => r.type !== "other").length, doors = regions.reduce((s, r) => s + r.doors.length, 0);
  const summary = { floor: fl, placed: how, turned: best.k * 90, halls, rooms: regions.length - halls, doors, added, replaced, partial, ...extra };
  return { plan, summary };
}

/** The History note for an automatic import. */
export function importNote(sessionId, s) {
  const where = { rooms: "lined up with the rooms already there", gps: "placed by the session's GPS", beside: "beside the other rooms", origin: "on an empty floor" }[s.placed];
  return `Worker mapped session ${sessionId}: ${s.halls} hallway${s.halls === 1 ? "" : "s"}, ${s.rooms} room${s.rooms === 1 ? "" : "s"}, ${s.doors} door${s.doors === 1 ? "" : "s"} on L${s.floor}, ${where}`
    + (s.replaced.length ? `; updated ${s.replaced.join(", ")}` : "") + (s.placedBlock ? "; block placed roughly on the map" : "");
}
