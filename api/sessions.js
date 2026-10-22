// GET /api/sessions: recent capture sessions. POST /api/sessions: submit one (logged-in students; no edit key).
// Sessions hold quality scores and counts. A session can reserve slots for photos,
// which the contributor then uploads one by one to /api/photos.
import { json, readJson, route } from "../lib/http.js";
import * as V from "../lib/validate.js";
import { addSession, listSessions } from "../lib/store.js";
import { photoStore } from "../lib/photos.js";
import { requireUser } from "../lib/auth.js";

export const GET = route(async () => json({ sessions: await listSessions() }));

export const POST = route(async req => {
  const [user, denied] = await requireUser(req); if (denied) return denied;
  const s = V.session(await readJson(req));
  s.author = user.studentId;
  if (!photoStore()) s.photos = 0;
  return json(await addSession(s), 201);
});
