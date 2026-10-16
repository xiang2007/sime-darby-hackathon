// GET /api/state: the current plan, recent versions (without plan bodies) and sessions.
// Clients poll this; send If-None-Match with the last ETag to get a cheap 304.
import { json, route } from "../lib/http.js";
import { getPlan, listVersions, listSessions, stamp } from "../lib/store.js";

export const GET = route(async req => {
  const etag = await stamp();
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag, "cache-control": "no-store" } });
  const [plan, versions, sessions] = await Promise.all([getPlan(), listVersions(), listSessions()]);
  return json({ plan, versions, sessions }, 200, { etag });
});
