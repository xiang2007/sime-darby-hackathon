// GET /api/health: tells the web app whether a shared database is available.
import { dbUrl, query } from "../lib/db.js";
import { json, editKeySet, editKeyOk } from "../lib/http.js";
import { photoStore } from "../lib/photos.js";
import { videoStore } from "../lib/videos.js";

export async function GET(req) {
  const base = { ok: true, editKey: true, editKeySet: editKeySet(), keyOk: editKeyOk(req), photos: !!photoStore(), videos: !!videoStore(), worker: !!process.env.WORKER_KEY, accounts: true };
  if (!dbUrl()) return json({ ...base, db: false, reason: "not_configured" });
  try { await query("SELECT 1"); return json({ ...base, db: true }); }
  catch (e) { console.error(e); return json({ ...base, db: false, reason: "unreachable" }); }
}
