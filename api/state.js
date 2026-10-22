// GET /api/state: the current plan, recent versions (without plan bodies) and sessions.
// Clients poll this; send If-None-Match with the last ETag to get a cheap 304.
// Guests (no login) get the plan with only public places in full (lib/privacy.js), and no versions or sessions:
// those name rooms and contributors, and are only shown in the Contribution tabs, which need a login.
import { json, route } from "../lib/http.js";
import { getPlan, listVersions, listSessions, lastWorker, stamp } from "../lib/store.js";
import { currentUser } from "../lib/auth.js";
import { guestPlan } from "../lib/privacy.js";

export const GET = route(async req => {
  const user = await currentUser(req);
  const etag = (await stamp()).replace(/"$/, user ? '.u"' : '.g"');   // guests and students get different bodies
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag, "cache-control": "no-store" } });
  if (!user) {
    const [plan, worker] = await Promise.all([getPlan(), lastWorker()]);
    return json({ plan: guestPlan(plan), versions: [], sessions: [], worker }, 200, { etag });
  }
  const [plan, versions, sessions, worker] = await Promise.all([getPlan(), listVersions(), listSessions(), lastWorker()]);
  return json({ plan, versions, sessions, worker }, 200, { etag });
});
