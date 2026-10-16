// Input validation for the API. Everything a client sends is rebuilt from
// known fields, so unknown keys never reach the database.

export const ROOM_TYPES = ["lecture", "lab", "corridor", "toilet", "lobby", "office", "stairs", "other"];
export const STAIR_KINDS = ["switchback", "straight", "lift"];
export const VERDICTS = ["accepted", "thin", "rejected"];

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
    block: str(s.block, 8, "block", { required: true }),
    floor: int(s.floor, -5, 200, "floor"),
    room: str(s.room, 24, "room", { required: true }),
    verdict: s.verdict,
    frames: int(s.frames, 0, 100000, "frames"),
    usable: int(s.usable, 0, 100000, "usable"),
    gaps: int(s.gaps, 0, 100000, "gaps"),
    marker: s.marker === true,
    detail: {
      reasons, tally,
      medians: { sharp: m.sharp == null ? null : num(m.sharp, 0, 1e7, "medians.sharp"), bright: m.bright == null ? null : num(m.bright, 0, 255, "medians.bright") },
    },
  };
}
