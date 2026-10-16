// Postgres access for the API routes. Works with any Postgres that Vercel can
// reach (Neon from the Vercel Marketplace is the default). Set DATABASE_URL
// (or POSTGRES_URL, which the Vercel storage integrations also set).
import pg from "pg";
import { SCHEMA } from "./schema.js";

export const dbUrl = () => process.env.DATABASE_URL || process.env.POSTGRES_URL || "";

let pool = null, ready = null;

function makePool(url) {
  const u = new URL(url);
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname) || u.searchParams.get("sslmode") === "disable";
  // Hosted providers whose certificates don't chain to a public CA can opt out of verification.
  const noVerify = u.searchParams.get("sslmode") === "no-verify" || process.env.PGSSL_NO_VERIFY === "1";
  u.searchParams.delete("sslmode");
  return new pg.Pool({
    connectionString: u.toString(),
    ssl: local ? false : { rejectUnauthorized: !noVerify },
    max: 3, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 8_000,
  });
}

/** Run one statement and return its rows. Creates the tables on first use. */
export async function query(text, params = []) {
  const url = dbUrl();
  if (!url) throw Object.assign(new Error("No database configured"), { code: "no_db" });
  if (!pool) pool = makePool(url);
  if (!ready) ready = pool.query(SCHEMA).catch(e => { ready = null; throw e; });
  await ready;
  return (await pool.query(text, params)).rows;
}

/** For tests: close the pool so the process can exit. */
export async function closeDb() { if (pool) await pool.end(); pool = null; ready = null; }
