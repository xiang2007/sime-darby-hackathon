// Data access for plans, versions and sessions.
import { query } from "./db.js";
import { VIDEO_CHUNK } from "./videos.js";

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
  kind: r.kind || "photos", ...(r.kind === "map" ? { video: { bytes: Number(r.video_bytes) || 0, type: r.video_type, parts: r.video_parts,
    uploaded: !!r.video_ready, deleted: !!r.video_deleted_at, file: r.detail?.file || null } } : {}),
  frames: r.frames, usable: r.usable, gaps: r.gaps, marker: r.marker, photos: r.photos ?? 0, photoSlots: r.photo_slots ?? 0,
  reasons: r.detail?.reasons || [], tally: r.detail?.tally || {}, medians: r.detail?.medians || {}, geo: r.detail?.geo || null,
  recon: r.recon_status ? { status: r.recon_status, at: ms(r.recon_finished || r.recon_claimed), worker: r.recon_worker,
    error: r.recon_error || null, result: r.recon_result || null } : null,
});
// The recon columns for a session; the result leaves out the bulky point lists (see getRecon).
const RECON_COLS = `r.status AS recon_status, r.claimed_at AS recon_claimed, r.finished_at AS recon_finished, r.worker AS recon_worker,
  r.error AS recon_error, r.result - 'wallPoints' - 'cameras' - 'path' - 'regions' AS recon_result`;
const PHOTO_COUNT = "(SELECT count(*)::int FROM photos p WHERE p.session_id = s.id AND p.ref IS NOT NULL)";

export async function listSessions(limit = 300) {
  return (await query(
    `SELECT s.*, ${PHOTO_COUNT} AS photos, ${RECON_COLS}
     FROM sessions s LEFT JOIN recon r ON r.session_id = s.id ORDER BY s.id DESC LIMIT $1`, [limit])).map(sessionOut);
}

export async function addSession(s) {
  const [r] = await query(
    `INSERT INTO sessions (author, block, floor, room, verdict, frames, usable, gaps, marker, detail, photo_slots)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11) RETURNING *`,
    [s.author || null, s.block, s.floor, s.room, s.verdict, s.frames, s.usable, s.gaps, s.marker, JSON.stringify(s.detail), s.photos || 0]);
  return sessionOut(r);
}

/** A walk video session (see api/videos.js). The video itself follows in pieces of VIDEO_CHUNK bytes. */
export async function addMapSession(s) {
  const [r] = await query(
    `INSERT INTO sessions (author, block, floor, room, verdict, frames, usable, gaps, marker, detail, kind, video_bytes, video_type, video_parts)
     VALUES ($1, $2, $3, '', 'accepted', 0, 0, 0, false, $4::jsonb, 'map', $5, $6, $7) RETURNING *`,
    [s.author || null, s.block, s.floor, JSON.stringify(s.detail), s.bytes, s.type, Math.ceil(s.bytes / VIDEO_CHUNK)]);
  return sessionOut(r);
}
/** The bits of a map session the video routes need, or null. */
export async function getVideoSession(id) {
  const [r] = await query(
    `SELECT id, at, kind, video_bytes, video_type, video_parts, video_ready, video_deleted_at,
            (SELECT count(*)::int FROM video_chunks c WHERE c.session_id = s.id) AS received
     FROM sessions s WHERE id = $1`, [id]);
  return r && r.kind === "map" ? { id: String(r.id), at: ms(r.at), bytes: Number(r.video_bytes), type: r.video_type, parts: r.video_parts,
    chunk: VIDEO_CHUNK, received: r.received, ready: r.video_ready, deleted: !!r.video_deleted_at } : null;
}
/**
 * Store piece i of a session's video (sending the same piece again replaces it, so a dropped upload can be retried).
 * Once every piece is in and they add up to the size given at the start, the session is ready for the worker.
 * Returns {received, ready}, or null if the video was already complete.
 */
export async function putVideoChunk(id, i, bytes) {
  const rows = await query(
    `INSERT INTO video_chunks (session_id, idx, data)
       SELECT id, $2, $3 FROM sessions WHERE id = $1 AND kind = 'map' AND NOT video_ready
     ON CONFLICT (session_id, idx) DO UPDATE SET data = EXCLUDED.data RETURNING idx`, [id, i, Buffer.from(bytes)]);
  if (!rows.length) return null;
  const [r] = await query(
    `UPDATE sessions s SET video_ready = true WHERE id = $1 AND NOT video_ready
       AND (SELECT count(*) FROM video_chunks c WHERE c.session_id = s.id) = s.video_parts
       AND (SELECT sum(octet_length(data)) FROM video_chunks c WHERE c.session_id = s.id) = s.video_bytes
     RETURNING video_ready`, [id]);
  const [c] = await query("SELECT count(*)::int AS n FROM video_chunks WHERE session_id = $1", [id]);
  return { received: c.n, ready: !!r };
}
/** Piece i of a finished video, or null. */
export async function getVideoChunk(id, i) {
  const [r] = await query(
    `SELECT c.data FROM video_chunks c JOIN sessions s ON s.id = c.session_id
     WHERE c.session_id = $1 AND c.idx = $2 AND s.video_ready`, [id, i]);
  return r ? r.data : null;
}
/** Delete a mapped video's pieces to free database space; the session keeps its size and type. */
export const dropVideo = id => query("DELETE FROM video_chunks WHERE session_id = $1", [id])
  .then(() => query("UPDATE sessions SET video_deleted_at = now() WHERE id = $1 AND kind = 'map'", [id]));

/** A cheap fingerprint of everything /api/state returns, used as its ETag. */
export async function stamp() {
  const [r] = await query(
    `SELECT (SELECT rev FROM plan WHERE id = 1) AS p, (SELECT max(rev) FROM versions) AS v, (SELECT count(*) FROM versions) AS vc,
            (SELECT max(id) FROM sessions) AS s, (SELECT count(*) FROM sessions) AS sc, (SELECT count(*) FILTER (WHERE video_ready) || '-' || count(video_deleted_at) FROM sessions) AS vu,
            (SELECT count(*) FROM photos WHERE ref IS NOT NULL) AS pc,
            (SELECT count(*) || '-' || coalesce((extract(epoch FROM max(greatest(claimed_at, coalesce(finished_at, claimed_at)))) * 1000)::bigint, 0) FROM recon) AS rc,
            (SELECT floor(extract(epoch FROM max(seen)) / 60) FROM workers) AS wm`);
  return `"${r.p ?? 0}.${r.v ?? 0}.${r.vc}.${r.s ?? 0}.${r.sc}.${r.vu}.${r.pc}.${r.rc}.${r.wm ?? 0}"`;
}

/* ---------- photos ---------- */
export const UPLOAD_WINDOW_MS = 2 * 60 * 60 * 1000;   // photos must arrive within 2 hours of the session

/**
 * Reserve slot i of a session for an upload. Returns {id} when the slot is free,
 * or {error} naming why not. The slot is held by a row with no ref until savePhotoData.
 */
export async function claimPhoto({ session, i, w, h, bytes }) {
  const [s] = await query("SELECT id, at, photo_slots FROM sessions WHERE id = $1", [session]);
  if (!s) return { error: "not_found" };
  if (i >= s.photo_slots) return { error: "no_slot" };
  if (Date.now() - ms(s.at) > UPLOAD_WINDOW_MS) return { error: "closed" };
  const [r] = await query(
    `INSERT INTO photos (session_id, idx, bytes, w, h) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (session_id, idx) DO UPDATE SET at = now(), bytes = EXCLUDED.bytes, w = EXCLUDED.w, h = EXCLUDED.h
       WHERE photos.ref IS NULL AND photos.at < now() - interval '2 minutes'   -- an upload that died part way
     RETURNING id`, [session, i, bytes, w, h]);
  return r ? { id: r.id } : { error: "taken" };
}
export const savePhotoData = (id, bytes) => query("UPDATE photos SET data = $2, ref = 'db' WHERE id = $1", [id, Buffer.from(bytes)]);
export const dropPhoto = id => query("DELETE FROM photos WHERE id = $1", [id]);

export async function listPhotos(session) {
  const rows = await query("SELECT id, idx, w, h, bytes, at FROM photos WHERE session_id = $1 AND ref IS NOT NULL ORDER BY idx", [session]);
  return rows.map(r => ({ id: String(r.id), i: r.idx, w: r.w, h: r.h, bytes: r.bytes, at: ms(r.at) }));
}
export async function getPhoto(id) {
  const [r] = await query("SELECT id, session_id, idx, data FROM photos WHERE id = $1 AND data IS NOT NULL", [id]);
  return r || null;
}

/* ---------- reconstruction jobs (worker/worker.py) ---------- */
export const MIN_RECON_PHOTOS = 8;
const STALE = "interval '2 hours'";   // a claim this old is treated as a worker that died

export async function workerSeen(name, version) {
  await query(`INSERT INTO workers (name, seen, version) VALUES ($1, now(), $2)
               ON CONFLICT (name) DO UPDATE SET seen = now(), version = EXCLUDED.version`, [name, version || null]);
}
export async function lastWorker() {
  const [r] = await query("SELECT name, seen, version FROM workers ORDER BY seen DESC LIMIT 1");
  return r ? { name: r.name, seen: ms(r.seen), version: r.version } : null;
}

// A walk video session is ready once every piece of its video has arrived (and it hasn't been deleted after mapping).
const MAP_READY = "(s.kind = 'map' AND s.video_ready AND s.video_deleted_at IS NULL)";

/**
 * Claim the oldest session that's ready: a walk video that has finished uploading, or photos that are ready to
 * measure: not rejected, at least MIN_RECON_PHOTOS photos, and its uploads finished (all reserved photos arrived,
 * or none for 10 minutes).
 * With session set, claim that one even if it was measured before (unless a worker is on it now).
 * Returns the session id, or null.
 */
export async function claimJob(worker, session) {
  const rows = session
    ? await query(
      `INSERT INTO recon (session_id, status, worker, claimed_at)
         SELECT s.id, 'processing', $1, now() FROM sessions s WHERE s.id = $2 AND (${MAP_READY} OR ${PHOTO_COUNT} >= ${MIN_RECON_PHOTOS})
       ON CONFLICT (session_id) DO UPDATE SET status = 'processing', worker = EXCLUDED.worker, claimed_at = now(),
         finished_at = NULL, error = NULL, result = NULL
         WHERE recon.status <> 'processing' OR recon.claimed_at < now() - ${STALE}
       RETURNING session_id`, [worker, session])
    : await query(
      `WITH c AS (
         SELECT s.id FROM sessions s LEFT JOIN recon r ON r.session_id = s.id
         WHERE (r.session_id IS NULL OR (r.status = 'processing' AND r.claimed_at < now() - ${STALE}))
           AND (${MAP_READY} OR (s.kind <> 'map' AND s.verdict <> 'rejected' AND s.photo_slots > 0
             AND ${PHOTO_COUNT} >= ${MIN_RECON_PHOTOS}
             AND (${PHOTO_COUNT} >= s.photo_slots OR (SELECT max(at) FROM photos p WHERE p.session_id = s.id) < now() - interval '10 minutes')))
         ORDER BY s.id LIMIT 1 FOR UPDATE OF s SKIP LOCKED)
       INSERT INTO recon (session_id, status, worker, claimed_at) SELECT id, 'processing', $1, now() FROM c
       ON CONFLICT (session_id) DO UPDATE SET status = 'processing', worker = EXCLUDED.worker, claimed_at = now(),
         finished_at = NULL, error = NULL, result = NULL
         WHERE recon.status = 'processing' AND recon.claimed_at < now() - ${STALE}
       RETURNING session_id`, [worker]);
  return rows.length ? String(rows[0].session_id) : null;
}

export async function getSession(id) {
  const [r] = await query(`SELECT s.*, ${PHOTO_COUNT} AS photos, ${RECON_COLS} FROM sessions s LEFT JOIN recon r ON r.session_id = s.id WHERE s.id = $1`, [id]);
  return r ? sessionOut(r) : null;
}

/** Record the worker's outcome. Returns false if the session isn't being processed. */
export async function finishJob(session, { status, result, error }) {
  const rows = await query(
    `UPDATE recon SET status = $2, finished_at = now(), result = $3::jsonb, error = $4
     WHERE session_id = $1 AND status = 'processing' RETURNING session_id`,
    [session, status, result ? JSON.stringify(result) : null, error || null]);
  return rows.length > 0;
}

/** Note on a finished measurement what happened when it was added to the plan: {rev, ...summary} or {error}. */
export const noteImport = (session, imported) =>
  query("UPDATE recon SET result = result || jsonb_build_object('imported', $2::jsonb) WHERE session_id = $1 AND status = 'done'", [session, JSON.stringify(imported)]);

/** The full measurement, including the wall points and camera positions. */
export async function getRecon(session) {
  const [r] = await query("SELECT status, worker, claimed_at, finished_at, error, result FROM recon WHERE session_id = $1", [session]);
  return r ? { status: r.status, worker: r.worker, at: ms(r.finished_at || r.claimed_at), error: r.error, result: r.result } : null;
}

/** Forget a measurement so the session is measured again. */
export const resetRecon = session => query("DELETE FROM recon WHERE session_id = $1 RETURNING session_id", [session]).then(r => r.length > 0);
