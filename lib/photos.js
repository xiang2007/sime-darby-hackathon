// Contributed photos are kept in the same Postgres database as everything else
// (Neon on Vercel), as JPEG bytes in photos.data. They're served back through /api/photos.
// Upload is on whenever a database is connected. Set PHOTO_UPLOAD=off to turn it off.
import { dbUrl } from "./db.js";

export const photoStore = () => (dbUrl() && process.env.PHOTO_UPLOAD !== "off" ? "db" : null);
