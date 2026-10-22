// GET /api/versions?rev=N: one saved revision with its full plan (for restore).
// GET /api/versions: the recent revisions without plan bodies.
// Both need a login: versions name every room, and History is a Contribution tab.
import { json, route } from "../lib/http.js";
import { getVersion, listVersions } from "../lib/store.js";
import { requireUser } from "../lib/auth.js";

export const GET = route(async req => {
  const [, guest] = await requireUser(req); if (guest) return guest;
  const rev = new URL(req.url).searchParams.get("rev");
  if (rev == null) return json({ versions: await listVersions() });
  if (!/^\d{1,9}$/.test(rev)) return json({ error: "invalid", message: "rev must be a number" }, 400);
  const v = await getVersion(+rev);
  return v ? json(v) : json({ error: "not_found", message: `Version r${rev} isn't kept any more.` }, 404);
});
