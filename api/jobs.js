// Reconstruction jobs for the worker that runs on someone's own computer (worker/worker.py).
//   POST   /api/jobs[?session=ID]   worker: claim the next session to measure (or that one). 204 when there's none.
//                                   body {name, version}. Returns {job: {kind: "photos", session, photos, room, marker}}
//                                   or, for a walk video, {job: {kind: "map", session, video}}: fetch its pieces
//                                   from /api/videos?session=ID&i=N (they're kept in the Neon database).
//   PUT    /api/jobs?session=ID     worker: report {status: "done", result} or {status: "failed", error}.
//                                   A finished map is added to the plan straight away (lib/mapimport.js), placed by
//                                   the session's GPS; the plan's History keeps the version before it. Then the
//                                   video is deleted to free database space, unless KEEP_VIDEOS=1.
//                                   A measured room goes on the plan too: over the drawn room with the same ID, or
//                                   where the session's GPS says, lined up with the walls around it (mergeScan).
//                                   The response says what happened: {ok, imported}.
//   GET    /api/jobs?session=ID     the full measurement, with wall points for the plan overlay
//   DELETE /api/jobs?session=ID     forget the measurement so the session is measured again (edit key)
// The worker authenticates with WORKER_KEY in x-worker-key.
import { json, readJson, route, requireKey, requireWorker, workerKeyOk } from "../lib/http.js";
import * as V from "../lib/validate.js";
import { claimJob, dropVideo, finishJob, getPlan, getRecon, getSession, listPhotos, noteImport, resetRecon, savePlan, workerSeen } from "../lib/store.js";
import { keepVideos, VIDEO_CHUNK } from "../lib/videos.js";
import { importNote, mergeMap, mergeScan, scanNote, Skip } from "../lib/mapimport.js";

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
  const session = await getSession(id);
  if (session.kind === "map") return json({ job: { kind: "map", session, video: { ...session.video, chunk: VIDEO_CHUNK } } });
  const [photos, plan] = await Promise.all([listPhotos(id), getPlan()]);
  const rooms = (plan?.rooms || []).filter(r => r.id === session.room);
  const room = rooms.find(r => r.floor === session.floor) || rooms[0] || null;
  const marker = room ? `APU|${plan.block || ""}|${String(room.floor).padStart(2, "0")}|${room.id}` : null;
  return json({ job: { kind: "photos", session, photos, room, marker } });
});

export const PUT = route(async req => {
  const denied = requireWorker(req); if (denied) return denied;
  const id = sessionParam(req);
  if (!id) throw new V.Invalid("Pass ?session=");
  const session = await getSession(id);
  if (!session) return notFound();
  const outcome = V.jobOutcome(await readJson(req), session.kind);
  const ok = await finishJob(id, outcome);
  if (!ok) return json({ error: "not_claimed", message: "That session isn't being processed by a worker." }, 409);
  if (outcome.status !== "done") return json({ ok: true });
  const map = session.kind === "map", worker = session.recon?.worker;
  const imported = await addToPlan(session, outcome.result, worker, map ? mergeMap : mergeScan, map ? importNote : scanNote, map ? "map" : "room");
  await noteImport(id, imported);
  // Keep the video if it couldn't be added, so Try again can map it again.
  if (map && !imported.error && !keepVideos()) await dropVideo(id).catch(e => console.error(e));
  return json({ ok: true, imported });
});

/** Add a finished map or room to the plan as a new revision, trying again if someone saves in between. */
async function addToPlan(session, result, worker, merge, note, what) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await getPlan();
    try {
      const { plan, summary } = merge(current, result, session);
      const r = await savePlan({ data: V.plan(plan), author: `Worker ${worker || ""}`.trim().slice(0, 60),
        note: note(session._id, summary).slice(0, 200), baseRev: current?.rev || 0, force: false });
      if (!r.conflict) return { rev: r.rev, ...summary };
    } catch (e) {
      if (e instanceof Skip) return { error: e.message, skipped: true };
      console.error(e);
      return { error: e instanceof V.Invalid ? `The ${what} couldn't be added to the plan: ${e.message}` : `The ${what} couldn't be added to the plan.` };
    }
  }
  return { error: `The plan kept changing while the ${what} was being added. Use Try again.` };
}

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
  const s = await getSession(id);
  if (s?.kind === "map" && s.video?.deleted)
    return json({ error: "video_deleted", message: "This walk's video was deleted after it was mapped, so it can't be mapped again. Upload it again instead." }, 409);
  return (await resetRecon(id)) ? json({ ok: true }) : notFound();
});
