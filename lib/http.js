// Small helpers shared by the API routes (Web-standard Request/Response handlers).
import { createHash, timingSafeEqual } from "node:crypto";
import { Invalid } from "./validate.js";

export const MAX_BODY = 1_000_000;

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export async function readJson(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new Invalid("Request is too large");
  try { return JSON.parse(text); } catch { throw new Invalid("Request body is not valid JSON"); }
}

/** Optional shared edit key. When EDIT_KEY is set, every write must send it in x-edit-key. */
export const editKeyRequired = () => !!process.env.EDIT_KEY;
const same = (got, want) => { const h = s => createHash("sha256").update(s).digest(); return timingSafeEqual(h(got), h(want)); };
export function editKeyOk(req) {
  const want = process.env.EDIT_KEY;
  if (!want) return true;
  return same(req.headers.get("x-edit-key") || "", want);
}

/** The reconstruction worker (worker/worker.py) sends WORKER_KEY in x-worker-key. Without WORKER_KEY set, no worker can connect. */
export const workerKeyOk = req => !!process.env.WORKER_KEY && same(req.headers.get("x-worker-key") || "", process.env.WORKER_KEY);

/** Wrap a handler so validation and database errors become JSON responses. */
export function route(fn) {
  return async req => {
    try { return await fn(req); }
    catch (e) {
      if (e instanceof Invalid) return json({ error: "invalid", message: e.message }, 400);
      if (e?.code === "no_db") return json({ error: "no_db", message: "No database is configured on the server." }, 503);
      console.error(e);
      return json({ error: "server", message: "Something went wrong on the server." }, 500);
    }
  };
}

export function requireWorker(req) {
  if (!process.env.WORKER_KEY) return json({ error: "no_worker_key", message: "Set WORKER_KEY on the server to let a worker connect." }, 503);
  return workerKeyOk(req) ? null : json({ error: "worker_key", message: "The worker key is wrong." }, 401);
}

export const requireKey = req => editKeyOk(req) ? null : json({ error: "edit_key", message: "This deployment needs the edit key to make changes." }, 401);
