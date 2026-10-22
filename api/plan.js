// PUT /api/plan: save the whole plan as a new revision.
// Body: {plan: {block, floors, rooms}, baseRev, note, by, force}
// 409 with the current plan if someone else saved after baseRev (unless force).
import { json, readJson, route, requireKey } from "../lib/http.js";
import * as V from "../lib/validate.js";
import { getPlan, savePlan } from "../lib/store.js";
import { currentUser } from "../lib/auth.js";

export const GET = route(async () => json({ plan: await getPlan() }));

export const PUT = route(async req => {
  const denied = requireKey(req); if (denied) return denied;
  const b = await readJson(req);
  const data = V.plan(b.plan);
  const baseRev = Number.isInteger(b.baseRev) && b.baseRev >= 0 ? b.baseRev : 0;
  const note = typeof b.note === "string" ? b.note.trim().slice(0, 200) : "";
  const user = await currentUser(req);
  const r = await savePlan({ data, author: user ? user.studentId : V.author(b.by), note, baseRev, force: b.force === true });
  if (r.conflict) return json({ error: "conflict", message: "Someone else saved the plan first.", plan: r.conflict }, 409);
  return json(r);
});
