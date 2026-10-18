// Input validation for the API. Everything a client sends is rebuilt from
// known fields, so unknown keys never reach the database.

export const ROOM_TYPES = ["lecture", "lab", "corridor", "toilet", "lobby", "office", "stairs", "other"];
export const STAIR_KINDS = ["switchback", "straight", "lift"];
export const VERDICTS = ["accepted", "thin", "rejected"];
export const MAX_PHOTOS = 200;              // per session
export const MAX_PHOTO_BYTES = 4_000_000;   // per photo; Vercel functions accept bodies up to 4.5 MB

export class Invalid extends Error {}
const fail = msg => { throw new Invalid(msg); };

const str = (v, max, name, { required = false } = {}) => {
  if (v == null || v === "") { if (required) fail(`${name} is required`); return ""; }
  if (typeof v !== "string") fail(`${name} must be text`);
  const s = v.trim();
  if (s.length > max) fail(`${name} is longer than ${max} characters`);
  if (required && !s) fail(`${name} is required`);
  return s;
};
const num = (v, lo, hi, name) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) fail(`${name} must be a number from ${lo} to ${hi}`);
  return v;
};
const int = (v, lo, hi, name) => { num(v, lo, hi, name); if (!Number.isInteger(v)) fail(`${name} must be a whole number`); return v; };
const arr = (v, max, name) => {
  if (!Array.isArray(v)) fail(`${name} must be a list`);
  if (v.length > max) fail(`${name} has more than ${max} items`);
  return v;
};

/** Contributor display name (free text; there are no accounts). */
export const author = v => str(v, 60, "Name");

export function plan(p) {
  if (!p || typeof p !== "object") fail("plan is missing");
  const floors = arr(p.floors, 100, "floors").map((f, i) => ({
    level: int(f?.level, -5, 200, `floors[${i}].level`),
    name: str(f?.name, 40, `floors[${i}].name`) || `Level ${f.level}`,
  }));
  if (!floors.length) fail("plan needs at least one floor");
  if (new Set(floors.map(f => f.level)).size !== floors.length) fail("two floors share a level number");
  const rooms = arr(p.rooms, 3000, "rooms").map((r, i) => room(r, `rooms[${i}]`));
  return { block: str(p.block, 8, "block"), floors, rooms };
}

function room(r, at) {
  if (!r || typeof r !== "object") fail(`${at} is not a room`);
  const poly = arr(r.poly, 200, `${at}.poly`).map((pt, j) => {
    if (!Array.isArray(pt) || pt.length !== 2) fail(`${at}.poly[${j}] must be [x, y]`);
    return [num(pt[0], -1e5, 1e5, `${at}.poly[${j}][0]`), num(pt[1], -1e5, 1e5, `${at}.poly[${j}][1]`)];
  });
  if (poly.length < 3) fail(`${at} needs at least 3 corners`);
  if (!ROOM_TYPES.includes(r.type)) fail(`${at}.type is not a known room type`);
  const out = {
    k: str(r.k, 16, `${at}.k`, { required: true }),
    id: str(r.id, 24, `${at}.id`, { required: true }),
    name: str(r.name, 60, `${at}.name`),
    type: r.type,
    floor: int(r.floor, -5, 200, `${at}.floor`),
    height: num(r.height, 2.2, 12, `${at}.height`),
    poly,
    doors: arr(r.doors ?? [], 50, `${at}.doors`).map((d, j) => ({
      e: int(d?.e, 0, poly.length - 1, `${at}.doors[${j}].e`),
      t: num(d?.t, 0, 1, `${at}.doors[${j}].t`),
      w: num(d?.w, 0.3, 5, `${at}.doors[${j}].w`),
    })),
  };
  if (r.stair != null) {
    const s = r.stair;
    if (typeof s !== "object" || !STAIR_KINDS.includes(s.kind)) fail(`${at}.stair.kind must be one of ${STAIR_KINDS.join(", ")}`);
    out.stair = { kind: s.kind, dir: int(s.dir, 0, 3, `${at}.stair.dir`), mirror: s.mirror === true };
  }
  return out;
}

export function session(s) {
  if (!s || typeof s !== "object") fail("session is missing");
  if (!VERDICTS.includes(s.verdict)) fail("verdict must be accepted, thin or rejected");
  const reasons = arr(s.reasons ?? [], 10, "reasons").map((x, i) => str(x, 200, `reasons[${i}]`));
  const tally = {};
  if (s.tally != null) {
    if (typeof s.tally !== "object" || Array.isArray(s.tally)) fail("tally must be an object");
    const keys = Object.keys(s.tally);
    if (keys.length > 10) fail("tally has too many entries");
    for (const k of keys) tally[str(k, 40, "tally key")] = int(s.tally[k], 0, 100000, `tally.${k}`);
  }
  const m = s.medians ?? {};
  return {
    author: author(s.by),
    block: str(s.block, 8, "block"),       // optional: a session can start anywhere
    floor: int(s.floor, -5, 200, "floor"),
    room: str(s.room, 24, "room"),         // optional: blank means the room isn't known yet
    verdict: s.verdict,
    frames: int(s.frames, 0, 100000, "frames"),
    usable: int(s.usable, 0, 100000, "usable"),
    gaps: int(s.gaps, 0, 100000, "gaps"),
    marker: s.marker === true,
    photos: s.photos == null ? 0 : int(s.photos, 0, Math.min(MAX_PHOTOS, typeof s.frames === "number" ? s.frames : 0), "photos"),
    detail: {
      reasons, tally,
      medians: { sharp: m.sharp == null ? null : num(m.sharp, 0, 1e7, "medians.sharp"), bright: m.bright == null ? null : num(m.bright, 0, 255, "medians.bright") },
    },
  };
}

/** Query parameters for one photo upload: ?session=&i=&w=&h= */
export function photoParams(url) {
  const q = new URL(url).searchParams, n = (k, lo, hi) => {
    const v = q.get(k);
    if (v == null || !/^\d+$/.test(v)) fail(`${k} must be a whole number`);
    return int(+v, lo, hi, k);
  };
  return { session: n("session", 1, Number.MAX_SAFE_INTEGER), i: n("i", 0, MAX_PHOTOS - 1), w: n("w", 1, 20000), h: n("h", 1, 20000) };
}

/** True if the bytes start like a JPEG file. */
export const isJpeg = b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/* ---------- reconstruction results from the worker ---------- */
const point = (p, at) => {
  if (!Array.isArray(p) || p.length !== 2) fail(`${at} must be [x, y]`);
  return [num(p[0], -1e5, 1e5, `${at}[0]`), num(p[1], -1e5, 1e5, `${at}[1]`)];
};
const points = (v, max, at) => arr(v ?? [], max, at).map((p, i) => point(p, `${at}[${i}]`));
const SCALE_SOURCES = ["marker", "phone_height"], CONFIDENCE = ["high", "medium", "low"];

/** What a worker reports for a session it measured. Lengths in metres, plan coordinates. */
export function reconResult(r) {
  if (!r || typeof r !== "object") fail("result is missing");
  const poly = points(r.poly, 200, "poly");
  if (poly.length < 3) fail("poly needs at least 3 corners");
  const sc = r.scale ?? {};
  if (!SCALE_SOURCES.includes(sc.source)) fail("scale.source must be marker or phone_height");
  if (!CONFIDENCE.includes(sc.confidence)) fail("scale.confidence must be high, medium or low");
  const img = r.images ?? {};
  return {
    poly,
    size: [num(r.size?.[0], 0, 1e4, "size[0]"), num(r.size?.[1], 0, 1e4, "size[1]")],
    area: num(r.area, 0, 1e6, "area"),
    height: r.height == null ? null : num(r.height, 0, 100, "height"),
    scale: { source: sc.source, confidence: sc.confidence, views: int(sc.views ?? 0, 0, 10000, "scale.views") },
    images: { placed: int(img.placed ?? 0, 0, 10000, "images.placed"), total: int(img.total ?? 0, 0, 10000, "images.total") },
    points: int(r.points ?? 0, 0, 1e8, "points"),
    aligned: r.aligned === true,
    match: r.match == null ? null : num(r.match, 0, 1, "match"),
    notes: arr(r.notes ?? [], 10, "notes").map((x, i) => str(x, 300, `notes[${i}]`)),
    marker: r.marker == null ? null : point(r.marker, "marker"),
    wallPoints: points(r.wallPoints, 3000, "wallPoints"),
    cameras: points(r.cameras, 1000, "cameras"),
    worker: { version: str(r.worker?.version, 20, "worker.version") },
  };
}

/** The worker's report: {status: "done", result} or {status: "failed", error}. */
export function jobOutcome(b) {
  if (!b || typeof b !== "object") fail("body is missing");
  if (b.status === "done") return { status: "done", result: reconResult(b.result) };
  if (b.status === "failed") return { status: "failed", error: str(b.error, 300, "error") || "Failed" };
  fail("status must be done or failed");
}

export const workerName = v => str(v, 60, "name") || "worker";
