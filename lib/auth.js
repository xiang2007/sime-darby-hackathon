// Student accounts and logins.
// Signing up takes an email, a student ID and a password; logging in takes the student ID and password.
// A login lasts LOGIN_HOURS (6 hours), then the student has to log in again.
// The browser keeps a random token and sends it as "authorization: Bearer <token>"; the database
// stores only its SHA-256, so a leaked database can't be used to log in.
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { query } from "./db.js";
import { json } from "./http.js";
import { Invalid } from "./validate.js";

export const LOGIN_HOURS = 6;
const LOGIN_MS = LOGIN_HOURS * 3600_000;
const scryptAsync = promisify(scrypt);
const sha = s => createHash("sha256").update(s).digest("hex");
const ms = t => (t instanceof Date ? t.getTime() : new Date(t).getTime());

/* ---------- validation ---------- */
const text = (v, name) => { if (typeof v !== "string" || !v.trim()) throw new Invalid(`${name} is required`); return v.trim(); };
export function email(v) {
  const s = text(v, "Email").toLowerCase();
  if (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new Invalid("Enter a valid email address");
  return s;
}
/** Student IDs like TP012345: letters, digits and dashes, stored in capitals. */
export function studentId(v) {
  const s = text(v, "Student ID").toUpperCase();
  if (!/^[A-Z0-9-]{3,20}$/.test(s)) throw new Invalid("Student ID must be 3 to 20 letters, digits or dashes");
  return s;
}
export function password(v) {
  if (typeof v !== "string" || !v) throw new Invalid("Password is required");
  if (v.length < 8) throw new Invalid("Password must be at least 8 characters");
  if (v.length > 200) throw new Invalid("Password is longer than 200 characters");
  return v;
}

/* ---------- passwords ---------- */
export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(pw, salt, 32);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}
export async function checkPassword(pw, stored) {
  const [kind, salt, hash] = String(stored || "").split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64");
  const got = await scryptAsync(pw, Buffer.from(salt, "base64"), want.length);
  return timingSafeEqual(got, want);
}
// Compared against when the student ID doesn't exist, so a wrong ID takes as long as a wrong password.
const DUMMY = "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/* ---------- accounts and logins ---------- */
const publicUser = u => ({ email: u.email, studentId: u.student_id });

async function startLogin(userId) {
  const token = randomBytes(32).toString("base64url");
  const [r] = await query(
    "INSERT INTO logins (token_hash, user_id, expires_at) VALUES ($1, $2, now() + $3 * interval '1 millisecond') RETURNING expires_at",
    [sha(token), userId, LOGIN_MS]);
  // Clear out expired logins now and then.
  if (Math.random() < 0.05) await query("DELETE FROM logins WHERE expires_at < now()").catch(() => {});
  return { token, expiresAt: ms(r.expires_at) };
}

/** Create an account and log it in. {error: "taken", field} if the email or student ID is already used. */
export async function register(body) {
  const e = email(body?.email), id = studentId(body?.studentId), pw = password(body?.password);
  const hash = await hashPassword(pw);
  const rows = await query(
    `INSERT INTO users (email, student_id, pw_hash) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING RETURNING id, email, student_id`, [e, id, hash]);
  if (!rows.length) {
    const [dup] = await query("SELECT email = $1 AS same_email FROM users WHERE email = $1 OR student_id = $2 LIMIT 1", [e, id]);
    return { error: "taken", field: dup?.same_email ? "email" : "studentId" };
  }
  return { user: publicUser(rows[0]), ...(await startLogin(rows[0].id)) };
}

/** Log in with student ID and password. null if either is wrong. */
export async function login(body) {
  const id = studentId(body?.studentId);
  const pw = typeof body?.password === "string" ? body.password.slice(0, 200) : "";
  if (!pw) throw new Invalid("Password is required");
  const [u] = await query("SELECT id, email, student_id, pw_hash FROM users WHERE student_id = $1", [id]);
  const ok = await checkPassword(pw, u ? u.pw_hash : DUMMY);
  if (!u || !ok) return null;
  return { user: publicUser(u), ...(await startLogin(u.id)) };
}

const tokenOf = req => (req.headers.get("authorization") || "").match(/^Bearer\s+([\w-]{20,100})$/)?.[1] || "";

/** The logged-in student for this request, or null when there's no login or it has expired. */
export async function currentUser(req) {
  const t = tokenOf(req); if (!t) return null;
  const [r] = await query(
    `SELECT u.email, u.student_id, l.expires_at FROM logins l JOIN users u ON u.id = l.user_id
     WHERE l.token_hash = $1 AND l.expires_at > now()`, [sha(t)]);
  return r ? { ...publicUser(r), expiresAt: ms(r.expires_at) } : null;
}

export async function logout(req) {
  const t = tokenOf(req); if (t) await query("DELETE FROM logins WHERE token_hash = $1", [sha(t)]);
}

/** For routes only logged-in students may use. Returns [user, null] or [null, a 401 response]. */
export async function requireUser(req) {
  const u = await currentUser(req);
  return u ? [u, null] : [null, json({ error: "login", message: "Please log in first. Logins last 6 hours." }, 401)];
}
