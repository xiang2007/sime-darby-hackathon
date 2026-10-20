// Walk videos (for worker.py --map) are kept in the same Postgres database as everything else (Neon on Vercel).
// A Vercel function accepts at most 4.5 MB per request, so the browser sends a video in pieces of VIDEO_CHUNK bytes,
// and the worker fetches them back one by one. Once a video is mapped its pieces are deleted, since Neon's free
// tier holds only 0.5 GB; set KEEP_VIDEOS=1 to keep them. Set VIDEO_UPLOAD=off to turn video uploads off.
import { dbUrl } from "./db.js";

export const VIDEO_CHUNK = 4_000_000;
export const videoStore = () => (dbUrl() && process.env.VIDEO_UPLOAD !== "off" ? "db" : null);
export const keepVideos = () => process.env.KEEP_VIDEOS === "1";
