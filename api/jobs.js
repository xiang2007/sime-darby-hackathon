// Reconstruction jobs for the worker that runs on someone's own computer (worker/worker.py).
//   POST   /api/jobs[?session=ID]   worker: claim the next session to measure (or that one). 204 when there's none.
//                                   body {name, version}. Returns {job: {session, photos, room, marker}}.
//   PUT    /api/jobs?session=ID     worker: report {status: "done", result} or {status: "failed", error}
//   GET    /api/jobs?session=ID     the full measurement, with wall points for the plan overlay
//   DELETE /api/jobs?session=ID     forget the measurement so the session is measured again (edit key)
// The worker authenticates with WORKER_KEY in x-worker-key.
import { json, readJson, route, requireKey, requireWorker, workerKeyOk } from "../lib/http.js";
import * as V from "../lib/validate.js";
import { claimJob, finishJob, getPlan, getRecon, getSession, listPhotos, resetRecon, workerSeen } from "../lib/store.js";

const sessionParam = req => {
  const v = new URL(req.url).searchParams.get("session");
  if (v == null) return null;
  if (!/^\d{1,18}$/.test(v)) throw new V.Invalid("session must be a whole number");
  return v;
};
const notFound = () => json({ error: "not_found", message: "That session has no measurement." }, 404);

export const POST = route(async req => {
  const denied = requireWorker(req); if (denied) return denied;
  const b = await readJson(req).catch(() => ({}));
  const name = V.workerName(b.name);
  await workerSeen(name, typeof b.version === "string" ? b.version.slice(0, 20) : null);
  const id = await claimJob(name, sessionParam(req));
  if (!id) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  const [session, photos, plan] = await Promise.all([getSession(id), listPhotos(id), getPlan()]);
  const rooms = (plan?.rooms || []).filter(r => r.id === session.room);
  const room = rooms.find(r => r.floor === session.floor) || rooms[0] || null;
  const marker = room ? `APU|${plan.block || ""}|${String(room.floor).padStart(2, "0")}|${room.id}` : null;
  return json({ job: { session, photos, room, marker } });
});

export const PUT = route(async req => {
  const denied = requireWorker(req); if (denied) return denied;
  const id = sessionParam(req);
  if (!id) throw new V.Invalid("Pass ?session=");
  const ok = await finishJob(id, V.jobOutcome(await readJson(req)));
  if (!ok) return json({ error: "not_claimed", message: "That session isn't being processed by a worker." }, 409);
  return json({ ok: true });
});

export const GET = route(async req => {
  if (!workerKeyOk(req)) { const denied = requireKey(req); if (denied) return denied; }
  const id = sessionParam(req);
  if (!id) throw new V.Invalid("Pass ?session=");
  const r = await getRecon(id);
  return r ? json({ recon: r }) : notFound();
});

export const DELETE = route(async req => {
  const denied = requireKey(req); if (denied) return denied;
  const id = sessionParam(req);
  if (!id) throw new V.Invalid("Pass ?session=");
  return (await resetRecon(id)) ? json({ ok: true }) : notFound();
});
