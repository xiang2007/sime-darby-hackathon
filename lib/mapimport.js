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
// After 1 or 2 the map is nudged (up to 0.6 m after 1, 1.5 m after 2) so its walls line up with the walls of the
// rooms around it and the building's outside walls (snapShift).
//
// A room measured from photos (worker.py, Contribute → Live camera or photos) goes in the same way (mergeScan): over
// the drawn room with the same ID if there is one, else by GPS, then lined up with the walls around it.
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
// Pk and kCost (optional, one per turn k): where the middle of the path goes for that turn, and how badly that turn
// fits the GPS (from where each photo was taken, see fitShots).
export function placeByGps(regions, path, P, acc, building, others, { doors = [], halls = [], Pk = null, kCost = null } = {}) {
  const S = samplePoints(regions), c = path?.length ? centroid(path) : (b => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2])(bbox(S));
  const R = Math.max(5, Math.min(40, acc || 20)), step = R > 20 ? 2 : 1;
  const ob = others.map(p => ({ p, b: bbox(p) }));
  const inOther = q => ob.some(o => q[0] >= o.b[0] && q[0] <= o.b[2] && q[1] >= o.b[1] && q[1] <= o.b[3] && inside(q, o.p));
  if (!building && !others.length && !kCost) return { k: 0, t: [P[0] - c[0], P[1] - c[1]], fit: null, off: 0 };
  let best = null;
  for (let k = 0; k < 4; k++) {
    const Sk = S.map(p => rot(p, k)), ck = rot(c, k), Pc = Pk ? Pk[k] : P, cost = kCost ? kCost[k] : 0;
    for (let dx = -R; dx <= R; dx += step) for (let dy = -R; dy <= R; dy += step) {
      const off = Math.hypot(dx, dy); if (off > R) continue;
      const t = [Pc[0] + dx - ck[0], Pc[1] + dy - ck[1]];
      let fit = 0, clash = 0;
      for (const p of Sk) { const q = [p[0] + t[0], p[1] + t[1]]; if (building && inside(q, building)) fit++; if (others.length && inOther(q)) clash++; }
      // A door seen in the photos should open onto a hallway that's already on the plan.
      const onHall = doors.length && halls.length ? doors.filter(d => { const q = rot(d, k); return nearPoly([q[0] + t[0], q[1] + t[1]], halls, 1.0); }).length / doors.length : 0;
      const score = (building ? fit / Sk.length : 1) - clash / Sk.length + 0.15 * onHall - cost - 0.002 * off - 0.0001 * k;
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
    extra = { ...extra, building: B ? (B.name || B.id) : null, fit: p.fit == null ? null : +p.fit.toFixed(2), moved: +p.off.toFixed(1), ring: B?.ring };
  }

  // 3. Beside the other rooms
  if (!best) {
    const [x0, y0] = bbox(regions.flatMap(r => r.poly));
    best = { k: 0, t: others.length ? [bbox(others.flat())[2] + 2 - x0, bbox(others.flat())[1] - y0] : [-x0, -y0] };
    how = others.length ? "beside" : "origin";
  }
  if (how === "rooms" || how === "gps") {
    const moved = regions.map(r => r.poly.map(p => { const [x, y] = rot(p, best.k); return [x + best.t[0], y + best.t[1]]; }));
    const sn = snapShift(moved, others, { building: extra.ring || null, max: how === "rooms" ? 0.6 : 1.5 });
    if (sn.walls) { best.t = [best.t[0] + sn.shift[0], best.t[1] + sn.shift[1]]; extra.snapped = sn.walls; }
  }
  delete extra.ring;
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
    + (s.replaced.length ? `; updated ${s.replaced.join(", ")}` : "") + (s.snapped ? `; lined up with ${s.snapped} wall${s.snapped === 1 ? "" : "s"} nearby` : "")
    + (s.placedBlock ? "; block placed roughly on the map" : "");
}

/* ---------- lining walls up ---------- */
const TAN3 = Math.tan(3 * Math.PI / 180);
function segDist(q, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy);
}
const edgeDist = (q, p) => Math.min(...p.map((a, i) => segDist(q, a, p[(i + 1) % p.length])));
/** True if q is inside one of the outlines or within d metres of its edge. */
const nearPoly = (q, polys, d) => polys.some(p => inside(q, p) || edgeDist(q, p) <= d);
/** Walls square to the plan's grid (within 3°): {axis: 0 for x = at, 1 for y = at, at, lo, hi}. */
function axisEdges(p) {
  const out = [];
  p.forEach((a, i) => {
    const b = p[(i + 1) % p.length], dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]);
    if (Math.max(dx, dy) < 0.3) return;
    if (dx <= TAN3 * dy) out.push({ axis: 0, at: (a[0] + b[0]) / 2, lo: Math.min(a[1], b[1]), hi: Math.max(a[1], b[1]) });
    else if (dy <= TAN3 * dx) out.push({ axis: 1, at: (a[1] + b[1]) / 2, lo: Math.min(a[0], b[0]), hi: Math.max(a[0], b[0]) });
  });
  return out;
}
/** Points on a grid inside an outline (at least its centre), to check for overlaps. */
function interior(p, step = 0.5) {
  const [x0, y0, x1, y1] = bbox(p), out = [];
  for (let x = x0 + step / 2; x < x1; x += step) for (let y = y0 + step / 2; y < y1; y += step) if (inside([x, y], p)) out.push([x, y]);
  return out.length ? out : [centroid(p)];
}
/** How much of the outlines (shifted by s) lies well inside the other rooms. Shared walls don't count. */
function overlap(polys, others, s = [0, 0]) {
  if (!others.length) return 0;
  const pts = polys.flatMap(p => interior(p));
  return pts.filter(([x, y]) => { const q = [x + s[0], y + s[1]]; return others.some(o => inside(q, o) && edgeDist(q, o) > 0.15); }).length / pts.length;
}

/**
 * The small shift (at most max metres each way) that puts the new outlines' walls on the walls next to them: other
 * rooms' walls and the building's outside walls. It's only taken if it doesn't push the outlines into other rooms.
 * Returns {shift: [dx, dy], walls}: walls is how many wall pairs now line up.
 */
export function snapShift(polys, others, { building = null, max = 1.5 } = {}) {
  const mine = polys.flatMap(axisEdges), theirs = [...others, ...(building ? [building] : [])].flatMap(axisEdges);
  // The shifts along one axis that line walls up, best supported first (support: metres of wall that meet)
  const options = axis => {
    const cand = [];
    for (const e of mine) if (e.axis === axis) for (const f of theirs) if (f.axis === axis) {
      const d = f.at - e.at, ov = Math.min(e.hi, f.hi) - Math.max(e.lo, f.lo);
      if (Math.abs(d) <= max && ov >= 0.5) cand.push({ d, ov });
    }
    const out = [];
    for (const c of cand.sort((a, b) => Math.abs(a.d) - Math.abs(b.d))) {
      if (out.some(o => Math.abs(o.d - c.d) <= 0.1)) continue;
      const near = cand.filter(o => Math.abs(o.d - c.d) <= 0.1), w = near.reduce((s, o) => s + o.ov, 0);
      if (w >= 1) out.push({ w, n: near.length, d: near.reduce((s, o) => s + o.d * o.ov, 0) / w });
    }
    return out.sort((a, b) => b.w - a.w).slice(0, 3);
  };
  const xs = [...options(0), null], ys = [...options(1), null], before = overlap(polys, others);
  const tries = xs.flatMap(a => ys.map(b => [a, b])).filter(([a, b]) => a || b)
    .sort((p, q) => (q[0]?.w || 0) + (q[1]?.w || 0) - (p[0]?.w || 0) - (p[1]?.w || 0));
  for (const [a, b] of tries) {
    const shift = [a ? a.d : 0, b ? b.d : 0];
    if (overlap(polys, others, shift) <= before + 0.02) return { shift: shift.map(r2), walls: (a?.n || 0) + (b?.n || 0) };
  }
  return { shift: [0, 0], walls: 0 };
}

/* ---------- a room measured from photos ---------- */
const HALL = { maxWidth: 3.5, minRatio: 3, lobbyArea: 60, lobbyFill: 0.6, lobbyWidth: 6 };   // as in web/index.html
const polyArea = p => Math.abs(p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0)) / 2;
/** Corridor, lobby or an ordinary room, from the outline's shape (shapeOf in web/index.html). */
export function guessType(p) {
  const [x0, y0, x1, y1] = bbox(p), A = polyArea(p);
  let c = 0.1; while (((x1 - x0) / c + 2) * ((y1 - y0) / c + 2) > 250000) c *= 1.5;
  const nx = Math.ceil((x1 - x0) / c) + 2, ny = Math.ceil((y1 - y0) / c) + 2, d = new Float32Array(nx * ny), BIG = 1e9;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) d[j * nx + i] = inside([x0 + (i - 0.5) * c, y0 + (j - 0.5) * c], p) ? BIG : 0;
  // chamfer distance to the nearest cell outside the outline, in metres
  const D1 = c, D2 = c * Math.SQRT2;
  for (let j = 1; j < ny; j++) for (let i = 1; i < nx - 1; i++) { const k = j * nx + i; if (d[k]) d[k] = Math.min(d[k], d[k - 1] + D1, d[k - nx] + D1, d[k - nx - 1] + D2, d[k - nx + 1] + D2); }
  for (let j = ny - 2; j >= 0; j--) for (let i = nx - 2; i >= 1; i--) { const k = j * nx + i; if (d[k]) d[k] = Math.min(d[k], d[k + 1] + D1, d[k + nx] + D1, d[k + nx + 1] + D2, d[k + nx - 1] + D2); }
  // the centre line: cells at least as far from the walls as all their neighbours
  const ridge = [];
  for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const k = j * nx + i, v = d[k]; if (v < 2 * c) continue;
    if (v >= d[k - 1] && v >= d[k + 1] && v >= d[k - nx] && v >= d[k + nx] && v >= d[k - nx - 1] && v >= d[k - nx + 1] && v >= d[k + nx - 1] && v >= d[k + nx + 1]) ridge.push(v);
  }
  ridge.sort((a, b) => a - b);
  const width = ridge.length ? 2 * ridge[ridge.length >> 1] : Math.min(x1 - x0, y1 - y0), length = A / Math.max(width, 0.1), fill = A / Math.max((x1 - x0) * (y1 - y0), 1e-9);
  return width <= HALL.maxWidth && length >= HALL.minRatio * width ? "corridor"
    : A >= HALL.lobbyArea && fill < HALL.lobbyFill && width <= HALL.lobbyWidth ? "lobby" : "other";
}
/** How much two outlines overlap (intersection over union), from points on a grid. */
function iou(a, b) {
  const pa = interior(a, 0.25), pb = interior(b, 0.25);
  const ab = pa.filter(q => inside(q, b)).length * 0.0625, ba = pb.filter(q => inside(q, a)).length * 0.0625;
  const inter = (ab + ba) / 2, uni = pa.length * 0.0625 + pb.length * 0.0625 - inter;
  return uni > 0 ? inter / uni : 0;
}
/** The door at the door marker: on the edge the marker is nearest to, if it's within maxD metres of it. */
function markerDoor(poly, m, maxD = 1.0) {
  if (!m) return null;
  let best = null;
  poly.forEach((a, e) => {
    const b = poly[(e + 1) % poly.length], dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy; if (!L) return;
    const t = Math.max(0, Math.min(1, ((m[0] - a[0]) * dx + (m[1] - a[1]) * dy) / L)), d = Math.hypot(m[0] - a[0] - t * dx, m[1] - a[1] - t * dy);
    if (!best || d < best.d) best = { d, e, t, L: Math.sqrt(L) };
  });
  if (!best || best.d > maxD || best.L < DOOR_W) return null;
  const h = DOOR_W / 2 / best.L;   // keep the whole door on the wall
  return { e: best.e, t: +Math.max(h, Math.min(1 - h, best.t)).toFixed(4), w: DOOR_W };
}
/** Doors stay where they were: each moves to the nearest point on the new outline (remapDoors in web/index.html). */
function remapDoors(oldPoly, doors, poly) {
  return doors.map(d => {
    const a = oldPoly[d.e], b = oldPoly[(d.e + 1) % oldPoly.length]; if (!a || !b) return null;
    const c = [a[0] + (b[0] - a[0]) * d.t, a[1] + (b[1] - a[1]) * d.t], m = markerDoor(poly, c, Infinity);
    return m ? { ...m, w: d.w } : null;
  }).filter(Boolean);
}

export class Skip extends Error {}

/**
 * Line up where each photo was taken in the measurement (shots) with the GPS fix taken with it (photoGeo, by slot).
 * For each turn k: the move that best puts the photos on their fixes, and how far off they still are. With the photos
 * spread over a room or along a hallway, the right turn fits clearly better; GPS noise averages out over many photos.
 * Returns null without at least one photo with a fix within 60 m.
 */
export function fitShots(shots, photoGeo, g) {
  const pairs = (shots || []).map(s => ({ c: s.xy, f: photoGeo?.[s.i] }))
    .filter(p => p.f && Number.isFinite(p.f.lat) && Number.isFinite(p.f.lng) && Number.isFinite(p.f.acc) && p.f.acc <= 60)
    .map(p => ({ c: p.c, G: fromLatLng(p.f.lat, p.f.lng, g), w: 1 / Math.max(3, p.f.acc) ** 2, acc: p.f.acc }));
  if (!pairs.length) return null;
  const W = pairs.reduce((s, p) => s + p.w, 0), accs = pairs.map(p => p.acc).sort((a, b) => a - b), acc = accs[accs.length >> 1];
  const fits = [0, 1, 2, 3].map(k => {
    const t = [0, 1].map(i => pairs.reduce((s, p) => s + p.w * (p.G[i] - rot(p.c, k)[i]), 0) / W);
    const res = Math.sqrt(pairs.reduce((s, p) => { const q = rot(p.c, k); return s + p.w * ((p.G[0] - q[0] - t[0]) ** 2 + (p.G[1] - q[1] - t[1]) ** 2); }, 0) / W);
    return { t, res };
  });
  const best = Math.min(...fits.map(f => f.res));
  // GPS errors between nearby fixes are partly shared, so many photos help, but not as much as if each were independent.
  return { n: pairs.length, acc, fits, R: Math.max(5, Math.min(40, acc / Math.sqrt(Math.min(pairs.length, 4)))),
    kCost: fits.map(f => pairs.length >= 3 ? 0.3 * (f.res - best) / Math.max(acc, 5) : 0) };
}
const meanFix = photoGeo => {
  const f = Object.values(photoGeo || {}).filter(x => x && x.acc <= 60); if (!f.length) return null;
  let w = 0, lat = 0, lng = 0; f.forEach(x => { const k = 1 / Math.max(3, x.acc) ** 2; w += k; lat += x.lat * k; lng += x.lng * k; });
  const a = f.map(x => x.acc).sort((p, q) => p - q);
  return { lat: lat / w, lng: lng / w, acc: a[a.length >> 1] };
};

/**
 * Put a room measured from photos on a copy of the plan. scan: the worker's result (reconResult in validate.js),
 * with poly, cameras and marker in its own frame, or already over the drawn room when aligned is true.
 * session: {_id, block, floor, room, geo, photoGeo}: photoGeo is each photo's GPS fix by slot, matched to scan.shots
 * (where each photo was taken in the scan) to place and turn the room. Returns {plan, summary}; summary.xf turns the
 * scan's points into the plan's.
 * Throws Skip when the drawn room is so different from the measured one that it's probably not the same room.
 */
export function mergeScan(planIn, scan, session, { campus = loadCampus() } = {}) {
  const plan = planIn ? JSON.parse(JSON.stringify({ block: planIn.block || "", floors: planIn.floors || [], rooms: planIn.rooms || [], ...(planIn.geo ? { geo: planIn.geo } : {}) }))
    : { block: "", floors: [], rooms: [] };
  const fl = Number.isInteger(session.floor) ? session.floor : 0, rid = String(session.room || "").trim().slice(0, 24);
  if (!plan.block) plan.block = String(session.block || "").trim().toUpperCase().slice(0, 8);
  // The drawn room the worker measured against (same choice as POST /api/jobs)
  const same = rid ? plan.rooms.filter(r => r.id === rid) : [], old = same.find(r => r.floor === fl) || same[0] || null;
  const floor = old ? old.floor : fl;
  const others = plan.rooms.filter(r => r.floor === floor && r !== old);
  const halls = others.filter(r => r.type === "corridor" || r.type === "lobby").map(r => r.poly);
  const height = scan.height ? Math.max(2.2, Math.min(12, +scan.height.toFixed(2))) : null;
  let k = 0, t = [0, 0], how, extra = {};

  if (old) {
    // 1. Over the drawn room: the worker lined it up already, unless the room was drawn after it started
    if (scan.aligned) extra.match = scan.match ?? iou(scan.poly, old.poly);
    else {
      const c = centroid(old.poly);
      const fits = [0, 1, 2, 3].map(kk => { const q = rot(centroid(scan.poly), kk), tt = [c[0] - q[0], c[1] - q[1]];
        return { k: kk, t: tt, m: iou(scan.poly.map(p => { const r = rot(p, kk); return [r[0] + tt[0], r[1] + tt[1]]; }), old.poly) }; });
      const f = fits.sort((a, b) => b.m - a.m)[0];
      k = f.k; t = f.t; extra.match = f.m;
    }
    extra.match = +extra.match.toFixed(2);
    if (extra.match < 0.3)
      throw new Skip(`The measured outline covers only ${Math.round(extra.match * 100)}% of ${old.id} as drawn, so it may be a different room. `
        + "It wasn't put on the plan. Compare them with Show on plan, and use it by hand if it's right.");
    how = "room";
  } else {
    // 2. By GPS: each photo where its own fix says, or else the middle of the photos at the session's fix
    const ok = g => g && Number.isFinite(g.lat) && Number.isFinite(g.lng) && (g.acc == null || g.acc <= 100);
    const gps = ok(session.geo) ? session.geo : meanFix(session.photoGeo), door = scan.marker ? [scan.marker] : [];
    if (ok(gps)) {
      let g = plan.geo;
      if (!g) { g = roughFrame(plan, campus, gps); plan.geo = g; extra.placedBlock = true; }
      const B = buildingAt(gps, g, campus), shots = fitShots(scan.shots, session.photoGeo, g);
      const path = shots ? scan.shots.map(s => s.xy) : scan.cameras, c = centroid(path.length ? path : scan.poly);
      const P = fromLatLng(gps.lat, gps.lng, g), opts = { doors: door, halls };
      if (shots) Object.assign(opts, { Pk: shots.fits.map((f, k) => { const q = rot(c, k); return [f.t[0] + q[0], f.t[1] + q[1]]; }), kCost: shots.kCost });
      const p = placeByGps([{ poly: scan.poly }], path.length ? path : null, P, shots ? shots.R : gps.acc, B?.ring || null, others.map(r => r.poly), opts);
      if (shots) extra.gpsPhotos = shots.n;
      k = p.k; t = p.t; how = "gps"; extra.ring = B?.ring || null;
      extra = { ...extra, building: B ? (B.name || B.id) : null, fit: p.fit == null ? null : +p.fit.toFixed(2), moved: +p.off.toFixed(1) };
    } else {
      // 3. Beside the other rooms
      const [x0, y0] = bbox(scan.poly), o = others.map(r => r.poly);
      t = o.length ? [bbox(o.flat())[2] + 1 - x0, bbox(o.flat())[1] - y0] : [-x0, -y0];
      how = o.length ? "beside" : "origin";
    }
  }
  const xf = q => { const [x, y] = rot(q, k); return [x + t[0], y + t[1]]; };
  if (how === "room" || how === "gps") {
    const sn = snapShift([scan.poly.map(xf)], others.map(r => r.poly), { building: extra.ring || null, max: how === "room" ? 0.6 : 1.5 });
    if (sn.walls) { t = [t[0] + sn.shift[0], t[1] + sn.shift[1]]; extra.snapped = sn.walls; }
  }
  delete extra.ring;
  const poly = scan.poly.map(q => xf(q).map(r2)), mk = scan.marker ? xf(scan.marker) : null;

  let room;
  if (old) {
    old.doors = remapDoors(old.poly, old.doors || [], poly);
    if (!old.doors.length) { const d = markerDoor(poly, mk); if (d) old.doors = [d]; }
    old.poly = poly;
    if (height) old.height = height;
    room = old;
  } else {
    if (!plan.floors.some(f => f.level === floor)) plan.floors.push({ level: floor, name: "Level " + floor });
    const ids = new Set(plan.rooms.map(r => r.id)), pre = `${plan.block || "X"}-${String(floor).padStart(2, "0")}`;
    let id = rid, i = 2;
    if (!id) { let n = others.length + 1; do id = `${pre}-${String(n++).padStart(2, "0")}`; while (ids.has(id)); }
    else while (ids.has(id)) id = `${rid}-${i++}`;
    const d = markerDoor(poly, mk), type = guessType(poly);
    room = { k: uid(), id, name: "", type, floor, height: height || 3.2, poly, doors: d ? [d] : [] };
    plan.rooms.push(room);
  }
  const summary = { floor, room: room.id, action: old ? "replaced" : "added", type: room.type, placed: how, turned: k * 90,
    height, doors: room.doors.length, xf: { k, t: t.map(v => +v.toFixed(3)) }, ...extra };
  return { plan, summary };
}

/** The History note for a room measured from photos. */
export function scanNote(sessionId, s) {
  const where = { room: `over the drawn room (${Math.round((s.match || 0) * 100)}% the same)`, gps: s.gpsPhotos ? `placed by the GPS of ${s.gpsPhotos} photo${s.gpsPhotos === 1 ? "" : "s"}` : "placed by the session's GPS",
    beside: "beside the other rooms", origin: "on an empty floor" }[s.placed];
  return `Worker measured session ${sessionId}: ${s.action === "replaced" ? `new outline for ${s.room}` : `added ${s.room}`} on L${s.floor}, ${where}`
    + (s.building ? ` in ${s.building}` : "") + (s.snapped ? `, lined up with ${s.snapped} wall${s.snapped === 1 ? "" : "s"} nearby` : "")
    + (s.height ? `, ${s.height} m high` : "") + (s.placedBlock ? "; block placed roughly on the map" : "");
}
