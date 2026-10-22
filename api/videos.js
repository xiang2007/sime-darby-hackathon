// Walk videos that the worker maps a floor from (worker.py --map). Logged-in students can contribute one, like photos.
// They're kept in the Neon Postgres database, in pieces of VIDEO_CHUNK bytes, because a Vercel function takes
// at most 4.5 MB per request.
//   POST /api/videos                 body {by, block, floor, geo?, bytes, type, name?}: start a walk video session.
//                                    201 {session}; session.video.parts says how many pieces to send
//   PUT  /api/videos?session=ID&i=N  body: piece N of the video (the raw bytes). Every piece is VIDEO_CHUNK bytes
//                                    but the last. Sending a piece again replaces it. {received, parts, ready};
//                                    once ready, a worker picks the session up
//   GET  /api/videos?session=ID      worker (x-worker-key) or editor: {bytes, type, parts, chunk, ready}
//   GET  /api/videos?session=ID&i=N  worker or editor: piece N
import { json, readJson, route, requireKey, workerKeyOk } from "../lib/http.js";
import * as V from "../lib/validate.js";
import { addMapSession, getVideoChunk, getVideoSession, putVideoChunk, UPLOAD_WINDOW_MS } from "../lib/store.js";
import { VIDEO_CHUNK, videoStore } from "../lib/videos.js";
import { requireUser } from "../lib/auth.js";

const noStore = () => json({ error: "no_video_store", message: "Video uploads are turned off on this deployment." }, 503);
const params = req => {
  const q = new URL(req.url).searchParams, id = q.get("session"), i = q.get("i");
  if (id != null && !/^\d{1,18}$/.test(id)) throw new V.Invalid("session must be a whole number");
  if (i != null && !/^\d{1,6}$/.test(i)) throw new V.Invalid("i must be a whole number");
  return { id, i: i == null ? null : Number(i) };
};
const missing = () => json({ error: "not_found", message: "That walk video session doesn't exist." }, 404);
// How big piece i must be.
const partSize = (s, i) => (i < s.parts - 1 ? VIDEO_CHUNK : s.bytes - VIDEO_CHUNK * (s.parts - 1));

export const POST = route(async req => {
  if (!videoStore()) return noStore();
  if (params(req).id) throw new V.Invalid("Start a session with POST /api/videos, then PUT its pieces.");
  const [user, denied] = await requireUser(req); if (denied) return denied;
  const s = V.mapSession(await readJson(req));
  s.author = user.studentId;
  return json(await addMapSession(s), 201);
});

export const PUT = route(async req => {
  if (!videoStore()) return noStore();
  const [, denied] = await requireUser(req); if (denied) return denied;
  const { id, i } = params(req);
  if (!id || i == null) throw new V.Invalid("Pass ?session=&i=");
  const s = await getVideoSession(id);
  if (!s) return missing();
  if (s.ready) return json({ error: "taken", message: "This session already has its video." }, 409);
  if (Date.now() - s.at > UPLOAD_WINDOW_MS) return json({ error: "closed", message: "Videos must be uploaded within 2 hours of starting the session." }, 409);
  if (i >= s.parts) throw new V.Invalid(`This video has ${s.parts} pieces (0 to ${s.parts - 1}).`);
  const want = partSize(s, i);
  if (+(req.headers.get("content-length") || 0) > want) throw new V.Invalid(`Piece ${i} must be ${want} bytes.`);
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length !== want) throw new V.Invalid(`Piece ${i} must be ${want} bytes, not ${bytes.length}.`);
  let r;
  try { r = await putVideoChunk(id, i, bytes); }
  catch (e) {
    console.error(e);
    // Most often the database is out of space (Neon's free tier holds 0.5 GB).
    return json({ error: "video_store", message: `Couldn't store the video: ${String(e?.message || e).slice(0, 200)}` }, 502);
  }
  if (!r) return json({ error: "taken", message: "This session already has its video." }, 409);
  return json({ ok: true, i, received: r.received, parts: s.parts, ready: r.ready });
});

export const GET = route(async req => {
  if (!workerKeyOk(req)) { const denied = requireKey(req); if (denied) return denied; }
  const { id, i } = params(req);
  if (!id) throw new V.Invalid("Pass ?session=");
  const s = await getVideoSession(id);
  if (!s) return missing();
  if (i == null) return json({ bytes: s.bytes, type: s.type, parts: s.parts, chunk: s.chunk, received: s.received, ready: s.ready, deleted: s.deleted });
  if (s.deleted) return json({ error: "deleted", message: "This video was deleted after it was mapped." }, 410);
  const data = s.ready ? await getVideoChunk(id, i) : null;
  if (!data) return json({ error: "not_found", message: s.ready ? `The video has no piece ${i}.` : "The video hasn't finished uploading." }, 404);
  return new Response(data, { headers: {
    "content-type": "application/octet-stream", "content-length": String(data.length), "cache-control": "private, no-store",
  } });
});
