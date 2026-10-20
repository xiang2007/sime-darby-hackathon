// Photos that contributors chose to upload with a capture session.
//   POST /api/photos?session=&i=&w=&h=[&lat=&lng=&acc=]   body: the JPEG (image/jpeg). Slot i must be one the
//                                        session reserved. lat/lng/acc: where it was taken (GPS-tagged sessions)
//   GET  /api/photos?session=ID          the session's photos: [{id, i, w, h, bytes, at, geo}]
//   GET  /api/photos?id=ID               one photo's bytes
// Anyone can upload to a session they submitted. Viewing photos needs the edit key (or the worker's WORKER_KEY).
import { json, route, requireKey, workerKeyOk } from "../lib/http.js";
import * as V from "../lib/validate.js";
import { claimPhoto, savePhotoData, dropPhoto, listPhotos, getPhoto } from "../lib/store.js";
import { photoStore } from "../lib/photos.js";

const noStore = () => json({ error: "no_photo_store", message: "Photo storage isn't set up on this deployment." }, 503);
const CLAIM_ERRORS = {
  not_found: [404, "That session doesn't exist."],
  no_slot: [409, "This session didn't reserve that many photos."],
  closed: [409, "Photos can only be added within 2 hours of submitting the session."],
  taken: [409, "That photo was already uploaded."],
};

export const GET = route(async req => {
  if (!workerKeyOk(req)) { const denied = requireKey(req); if (denied) return denied; }
  const q = new URL(req.url).searchParams, id = q.get("id"), session = q.get("session");
  if (id != null) {
    if (!/^\d{1,18}$/.test(id)) throw new V.Invalid("id must be a whole number");
    const p = await getPhoto(id);
    if (!p) return json({ error: "not_found", message: "That photo doesn't exist." }, 404);
    return new Response(p.data, { headers: {
      "content-type": "image/jpeg", "cache-control": "private, max-age=86400, immutable",
      "content-disposition": `inline; filename="session-${p.session_id}-${String(p.idx).padStart(3, "0")}.jpg"`,
    } });
  }
  if (session == null || !/^\d{1,18}$/.test(session)) throw new V.Invalid("Pass ?session= or ?id=");
  return json({ photos: await listPhotos(session) });
});

export const POST = route(async req => {
  if (!photoStore()) return noStore();
  const p = V.photoParams(req.url);
  if (+(req.headers.get("content-length") || 0) > V.MAX_PHOTO_BYTES) throw new V.Invalid("Photo is too large");
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > V.MAX_PHOTO_BYTES) throw new V.Invalid("Photo is too large");
  if (!V.isJpeg(bytes)) throw new V.Invalid("Photo must be a JPEG");

  const c = await claimPhoto({ ...p, bytes: bytes.length });
  if (c.error) { const [status, message] = CLAIM_ERRORS[c.error]; return json({ error: c.error, message }, status); }
  try {
    await savePhotoData(c.id, bytes);
  } catch (e) {
    await dropPhoto(c.id).catch(() => {});
    console.error(e);
    // Most often the database is out of space.
    return json({ error: "photo_store", message: `Couldn't store the photo: ${String(e?.message || e).slice(0, 200)}` }, 502);
  }
  return json({ id: String(c.id), i: p.i }, 201);
});
