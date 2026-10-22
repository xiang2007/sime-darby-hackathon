// Student accounts. A login lasts 6 hours.
//   POST   /api/auth  {action: "register", email, studentId, password}  201 {user, token, expiresAt}
//   POST   /api/auth  {action: "login", studentId, password}            200 {user, token, expiresAt}
//   GET    /api/auth  (authorization: Bearer <token>)                   200 {user, expiresAt} or 401
//   DELETE /api/auth  (authorization: Bearer <token>)                   log out
import { json, readJson, route } from "../lib/http.js";
import { Invalid } from "../lib/validate.js";
import { currentUser, login, logout, register } from "../lib/auth.js";

const TAKEN = { email: "An account with that email already exists. Log in instead.", studentId: "That student ID already has an account. Log in instead." };

export const POST = route(async req => {
  const b = await readJson(req);
  if (b?.action === "register") {
    const r = await register(b);
    if (r.error) return json({ error: "taken", field: r.field, message: TAKEN[r.field] }, 409);
    return json(r, 201);
  }
  if (b?.action === "login") {
    const r = await login(b);
    if (!r) return json({ error: "wrong", message: "Student ID or password is wrong." }, 401);
    return json(r);
  }
  throw new Invalid('action must be "register" or "login"');
});

export const GET = route(async req => {
  const u = await currentUser(req);
  if (!u) return json({ error: "login", message: "Not logged in, or the login has expired." }, 401);
  const { expiresAt, ...user } = u;
  return json({ user, expiresAt });
});

export const DELETE = route(async req => { await logout(req); return json({ ok: true }); });
