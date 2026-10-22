// GET /api/plan: the current plan. Guests get public places in full and only the outline of other rooms.
// PUT /api/plan: save the whole plan as a new revision (logged-in editors: edit key and a login).
// Body: {plan: {block, floors, rooms}, baseRev, note, by, force}
// 409 with the current plan if someone else saved after baseRev (unless force).
import { json, readJson, route, requireKey } from "../lib/http.js";
import * as V from "../lib/validate.js";
import { getPlan, savePlan } from "../lib/store.js";
import { currentUser, requireUser } from "../lib/auth.js";
import { guestPlan } from "../lib/privacy.js";

// Guests get classrooms, labs and offices without their number, name or type (lib/privacy.js).
export const GET = route(async req => {
  const plan = await getPlan();
  return json({ plan: (await currentUser(req)) ? plan : guestPlan(plan) });
});

export const PUT = route(async req => {
  const denied = requireKey(req); if (denied) return denied;
  const [user, guest] = await requireUser(req); if (guest) return guest;
  const b = await readJson(req);
  const data = V.plan(b.plan);
  const baseRev = Number.isInteger(b.baseRev) && b.baseRev >= 0 ? b.baseRev : 0;
  const note = typeof b.note === "string" ? b.note.trim().slice(0, 200) : "";
  const r = await savePlan({ data, author: user.studentId, note, baseRev, force: b.force === true });
  if (r.conflict) return json({ error: "conflict", message: "Someone else saved the plan first.", plan: r.conflict }, 409);
  return json(r);
});
