// Where contributed photos are kept.
//   Production: a Vercel Blob store. Connecting one to the project sets BLOB_READ_WRITE_TOKEN.
//     Photos are private by default and are served back through /api/photos.
//     Set BLOB_ACCESS=public only if the store was created as a public store.
//   Local dev and tests: a folder named by LOCAL_PHOTO_DIR.
// With neither set, photo upload is switched off and the app keeps photos on the phone.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

const access = () => (process.env.BLOB_ACCESS === "public" ? "public" : "private");

export function photoStore() {
  if (process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID) return "blob";
  if (process.env.LOCAL_PHOTO_DIR) return "local";
  return null;
}

function localPath(pathname) {
  const root = resolve(process.env.LOCAL_PHOTO_DIR), p = resolve(root, pathname);
  if (!p.startsWith(root + sep)) throw new Error("Bad photo path");
  return p;
}

/** Save JPEG bytes. Returns the reference to keep in the database. */
export async function savePhoto(pathname, bytes) {
  if (photoStore() === "blob") {
    const { put } = await import("@vercel/blob");
    const b = await put(pathname, bytes, { access: access(), contentType: "image/jpeg", addRandomSuffix: true });
    return b.url;
  }
  const p = localPath(pathname);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, bytes);
  return "local:" + pathname;
}

/** Read a saved photo back. Returns a body for new Response(), or null if it's gone. */
export async function loadPhoto(ref) {
  if (ref.startsWith("local:")) {
    try { return await readFile(localPath(ref.slice(6))); } catch { return null; }
  }
  const { get } = await import("@vercel/blob");
  const r = await get(ref, { access: access() });
  return r && r.statusCode === 200 ? r.stream : null;
}
