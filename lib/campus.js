// The OpenStreetMap campus snapshot (web/data/apu-campus.osm.json, from scripts/osm-campus.mjs), read on the server
// so walks mapped by the worker can be placed inside the right building. Same rules as parseCampus in web/index.html.
import { readFileSync } from "node:fs";

export const M_PER_DEG = 111320;
const CAMPUS_NAME = /asia pacific|\bAPU\b|\bAPIIT\b/i;
export const DEFAULT_LL = [3.0556, 101.7000];   // APU main building, as in web/index.html

export function inside(pt, p) {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i], [xj, yj] = p[j];
    if (((yi > pt[1]) !== (yj > pt[1])) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const llOf = g => g.filter(Boolean).map(p => [p.lat, p.lon]);
const closed = l => l.length > 3 && l[0][0] === l[l.length - 1][0] && l[0][1] === l[l.length - 1][1];
export const llInside = (ll, ring) => inside([ll[1], ll[0]], ring.map(p => [p[1], p[0]]));
export function llCentroid(ring) { const r = ring.slice(0, -1); return [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length]; }
function llArea(ring) {
  const k = Math.cos(ring[0][0] * Math.PI / 180); let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][1] * k + ring[i][1] * k) * (ring[j][0] - ring[i][0]);
  return Math.abs(a / 2) * M_PER_DEG * M_PER_DEG;
}
function joinRings(ways) {
  const todo = ways.filter(w => w.length > 1).map(w => w.slice()), rings = [], same = (a, b) => a[0] === b[0] && a[1] === b[1];
  while (todo.length) {
    let ring = todo.shift();
    for (let grew = true; grew && !closed(ring);) {
      grew = false;
      for (let i = 0; i < todo.length; i++) {
        const w = todo[i], end = ring[ring.length - 1];
        if (same(end, w[0])) ring = ring.concat(w.slice(1));
        else if (same(end, w[w.length - 1])) ring = ring.concat(w.slice(0, -1).reverse());
        else continue;
        todo.splice(i, 1); grew = true; break;
      }
    }
    if (closed(ring)) rings.push(ring);
  }
  return rings;
}

/** Overpass JSON to {campus, buildings}: rings are closed [lat, lng] lists; buildings carry inCampus. */
export function parseCampus(osm) {
  const C = { campus: null, buildings: [] }, areas = [];
  for (const e of osm?.elements || []) {
    const t = e.tags || {};
    let rings = [];
    if (e.type === "way" && e.geometry) { const l = llOf(e.geometry); if (closed(l)) rings = [l]; }
    if (e.type === "relation" && e.members) rings = joinRings(e.members.filter(m => m.type === "way" && m.role !== "inner" && m.geometry).map(m => llOf(m.geometry)));
    if (!rings.length) continue;
    const item = { id: `${e.type}/${e.id}`, name: t.name || "", rings, area: rings.reduce((s, r) => s + llArea(r), 0) };
    if (t.building) C.buildings.push(item);
    else if (t.amenity === "university" || t.landuse === "education") areas.push(item);
  }
  C.campus = areas.find(a => CAMPUS_NAME.test(a.name)) || areas.find(a => a.rings.some(r => llInside(DEFAULT_LL, r)))
    || areas.sort((a, b) => b.area - a.area)[0] || null;
  C.buildings.forEach(b => { b.inCampus = !C.campus || C.campus.rings.some(r => llInside(llCentroid(b.rings[0]), r)); });
  return C;
}

let cached;
/** The campus snapshot, or null when it isn't deployed. */
export function loadCampus() {
  if (cached !== undefined) return cached;
  try { cached = parseCampus(JSON.parse(readFileSync(new URL("../web/data/apu-campus.osm.json", import.meta.url), "utf8"))); }
  catch { cached = null; }
  return cached;
}
export const mainBuilding = C => C ? C.buildings.filter(b => b.inCampus).sort((a, b) => b.area - a.area)[0] || null : null;
