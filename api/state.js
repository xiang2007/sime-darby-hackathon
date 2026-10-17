// GET /api/state: the current plan, recent versions (without plan bodies) and sessions.
// Clients poll this; send If-None-Match with the last ETag to get a cheap 304.
import { json, route } from "../lib/http.js";
import { getPlan, listVersions, listSessions, lastWorker, stamp } from "../lib/store.js";

export const GET = route(async req => {
  const etag = await stamp();
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag, "cache-control": "no-store" } });
  const [plan, versions, sessions, worker] = await Promise.all([getPlan(), listVersions(), listSessions(), lastWorker()]);
  return json({ plan, versions, sessions, worker }, 200, { etag });
});
