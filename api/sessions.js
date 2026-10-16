// GET /api/sessions: recent capture sessions. POST /api/sessions: submit one.
// Sessions hold quality scores and counts only; photos are never uploaded.
import { json, readJson, route, requireKey } from "../lib/http.js";
import * as V from "../lib/validate.js";
import { addSession, listSessions } from "../lib/store.js";

export const GET = route(async () => json({ sessions: await listSessions() }));

export const POST = route(async req => {
  const denied = requireKey(req); if (denied) return denied;
  const s = V.session(await readJson(req));
  return json(await addSession(s), 201);
});
