// GET /api/health: tells the web app whether a shared database is available.
import { dbUrl, query } from "../lib/db.js";
import { json, editKeyRequired, editKeyOk } from "../lib/http.js";
import { photoStore } from "../lib/photos.js";

export async function GET(req) {
  const base = { ok: true, editKey: editKeyRequired(), keyOk: editKeyOk(req), photos: !!photoStore() };
  if (!dbUrl()) return json({ ...base, db: false, reason: "not_configured" });
  try { await query("SELECT 1"); return json({ ...base, db: true }); }
  catch (e) { console.error(e); return json({ ...base, db: false, reason: "unreachable" }); }
}
