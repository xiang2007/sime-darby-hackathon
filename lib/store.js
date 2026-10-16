// Data access for plans, versions and sessions.
import { query } from "./db.js";

export const KEEP_VERSIONS = 200;
const ms = t => (t instanceof Date ? t.getTime() : t == null ? null : new Date(t).getTime());

export async function getPlan() {
  const [r] = await query("SELECT rev, data, at, author FROM plan WHERE id = 1");
  return r ? { ...r.data, rev: r.rev, at: ms(r.at), by: r.author } : null;
}

/**
 * Save a new revision if nobody else saved since baseRev (or force is set).
 * Returns {rev, at} on success, or {conflict: currentPlan} when someone else got there first.
 */
export async function savePlan({ data, author, note, baseRev, force }) {
  const rows = await query(
    `WITH up AS (
       INSERT INTO plan (id, rev, data, at, author) VALUES (1, 1, $1::jsonb, now(), $2)
       ON CONFLICT (id) DO UPDATE
         SET rev = plan.rev + 1, data = EXCLUDED.data, at = EXCLUDED.at, author = EXCLUDED.author
         WHERE plan.rev = $3 OR $4::boolean
       RETURNING rev, data, at, author
     ), ver AS (
       INSERT INTO versions (rev, at, author, note, data) SELECT rev, at, author, $5, data FROM up
       ON CONFLICT (rev) DO UPDATE SET at = EXCLUDED.at, author = EXCLUDED.author, note = EXCLUDED.note, data = EXCLUDED.data
       RETURNING rev
     )
     SELECT up.rev, up.at FROM up`,
    [JSON.stringify(data), author || null, baseRev, !!force, note || null]);
  if (!rows.length) return { conflict: await getPlan() };
  const rev = rows[0].rev;
  await query("DELETE FROM versions WHERE rev <= $1", [rev - KEEP_VERSIONS]);
  return { rev, at: ms(rows[0].at) };
}

export async function listVersions(limit = 60) {
  const rows = await query(
    "SELECT rev, at, author, note, jsonb_array_length(data->'rooms') AS rooms FROM versions ORDER BY rev DESC LIMIT $1", [limit]);
  return rows.map(r => ({ rev: r.rev, at: ms(r.at), by: r.author, note: r.note, rooms: r.rooms }));
}

export async function getVersion(rev) {
  const [r] = await query("SELECT rev, at, author, note, data FROM versions WHERE rev = $1", [rev]);
  return r ? { rev: r.rev, at: ms(r.at), by: r.author, note: r.note, plan: r.data } : null;
}

const sessionOut = r => ({
  _id: String(r.id), at: ms(r.at), by: r.author, block: r.block, floor: r.floor, room: r.room, verdict: r.verdict,
  frames: r.frames, usable: r.usable, gaps: r.gaps, marker: r.marker,
  reasons: r.detail?.reasons || [], tally: r.detail?.tally || {}, medians: r.detail?.medians || {},
});

export async function listSessions(limit = 300) {
  return (await query("SELECT * FROM sessions ORDER BY id DESC LIMIT $1", [limit])).map(sessionOut);
}

export async function addSession(s) {
  const [r] = await query(
    `INSERT INTO sessions (author, block, floor, room, verdict, frames, usable, gaps, marker, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) RETURNING *`,
    [s.author || null, s.block, s.floor, s.room, s.verdict, s.frames, s.usable, s.gaps, s.marker, JSON.stringify(s.detail)]);
  return sessionOut(r);
}

/** A cheap fingerprint of everything /api/state returns, used as its ETag. */
export async function stamp() {
  const [r] = await query(
    `SELECT (SELECT rev FROM plan WHERE id = 1) AS p, (SELECT max(rev) FROM versions) AS v, (SELECT count(*) FROM versions) AS vc,
            (SELECT max(id) FROM sessions) AS s, (SELECT count(*) FROM sessions) AS sc`);
  return `"${r.p ?? 0}.${r.v ?? 0}.${r.vc}.${r.s ?? 0}.${r.sc}"`;
}
