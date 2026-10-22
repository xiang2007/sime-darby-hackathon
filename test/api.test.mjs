// API tests. The database tests need a throwaway Postgres:
//   TEST_DATABASE_URL=postgres://user:pass@localhost/apu_test npm test
// They wipe every table.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as V from "../lib/validate.js";

const room = (over = {}) => ({ k: "a1", id: "B-03-01", name: "Lab", type: "lab", floor: 3, height: 3.2,
  poly: [[0, 0], [4, 0], [4, 3], [0, 3]], doors: [{ e: 0, t: 0.5, w: 0.9 }], ...over });
const plan = (rooms = [room()]) => ({ block: "B", floors: [{ level: 3, name: "Level 3" }], rooms });

test("plan validation keeps known fields and drops the rest", () => {
  const p = V.plan({ ...plan([room({ evil: "<script>", stair: { kind: "switchback", dir: 2, mirror: true, x: 1 } })]), extra: 1 });
  assert.deepEqual(Object.keys(p), ["block", "floors", "rooms"]);
  assert.equal(p.rooms[0].evil, undefined);
  assert.deepEqual(p.rooms[0].stair, { kind: "switchback", dir: 2, mirror: true });
});

test("plan validation keeps the map placement", () => {
  const p = V.plan({ ...plan(), geo: { x: 20, y: 9.5, lat: 3.05531234567, lng: 101.70061234567, rot: 12.345, extra: 1 } });
  assert.deepEqual(p.geo, { x: 20, y: 9.5, lat: 3.0553123, lng: 101.7006123, rot: 12.35 });
  assert.throws(() => V.plan({ ...plan(), geo: { x: 0, y: 0, lat: 3, lng: 101, rot: 200 } }), V.Invalid);
  assert.throws(() => V.plan({ ...plan(), geo: { x: 0, y: 0, lat: "3", lng: 101, rot: 0 } }), V.Invalid);
  assert.throws(() => V.plan({ ...plan(), geo: [1, 2] }), V.Invalid);
  const snapped = V.plan({ ...plan(), geo: { x: 0, y: 0, lat: 3, lng: 101, rot: 0, osm: "way/123456" } });
  assert.equal(snapped.geo.osm, "way/123456");
  assert.throws(() => V.plan({ ...plan(), geo: { x: 0, y: 0, lat: 3, lng: 101, rot: 0, osm: "node/1" } }), V.Invalid);
});

test("plan validation keeps emergency exits on doors", () => {
  const p = V.plan(plan([room({ doors: [{ e: 0, t: 0.5, w: 0.9, exit: true }, { e: 1, t: 0.5, w: 0.9, exit: "yes" }] })]));
  assert.equal(p.rooms[0].doors[0].exit, true);
  assert.equal("exit" in p.rooms[0].doors[1], false);
});

test("plan validation rejects bad input", () => {
  assert.throws(() => V.plan(plan([room({ type: "dungeon" })])), V.Invalid);
  assert.throws(() => V.plan(plan([room({ poly: [[0, 0], [1, 1]] })])), V.Invalid);
  assert.throws(() => V.plan(plan([room({ doors: [{ e: 9, t: 0.5, w: 0.9 }] })])), V.Invalid);
  assert.throws(() => V.plan(plan([room({ height: Infinity })])), V.Invalid);
  assert.throws(() => V.plan(plan([room({ stair: { kind: "ladder", dir: 0 } })])), V.Invalid);
  assert.throws(() => V.plan({ block: "B", floors: [], rooms: [] }), V.Invalid);
});

test("session validation", () => {
  const s = V.session({ by: "Ana", block: "B", floor: 3, room: "B-03-01", verdict: "thin", frames: 12, usable: 10, gaps: 1,
    reasons: ["x"], tally: { blurry: 2 }, marker: true, medians: { sharp: 120.5, bright: 130 } });
  assert.equal(s.author, "Ana");
  assert.deepEqual(s.detail.tally, { blurry: 2 });
  assert.throws(() => V.session({ ...s, verdict: "great" }), V.Invalid);
  // A session can start anywhere: block and room tag are optional.
  const free = V.session({ floor: 3, verdict: "thin", frames: 1, usable: 1, gaps: 0 });
  assert.equal(free.room, "");
  assert.equal(free.block, "");
  assert.equal(free.detail.geo, undefined, "no location unless the contributor opts in");
  const g = V.session({ floor: 3, verdict: "thin", frames: 1, usable: 1, gaps: 0, geo: { lat: 3.0553123, lng: 101.7006789, acc: 23.6 } });
  assert.deepEqual(g.detail.geo, { lat: 3.05531, lng: 101.70068, acc: 24 });
  assert.throws(() => V.session({ floor: 3, verdict: "thin", frames: 1, usable: 1, gaps: 0, geo: { lat: 91, lng: 0, acc: 5 } }), V.Invalid);
  assert.throws(() => V.session({ floor: 3, verdict: "thin", frames: 1, usable: 1, gaps: 0, geo: { lat: "3", lng: 0, acc: 5 } }), V.Invalid);
});

test("photo validation", () => {
  assert.equal(V.session({ block: "B", floor: 3, room: "r", verdict: "thin", frames: 12, usable: 10, gaps: 0, photos: 10 }).photos, 10);
  assert.equal(V.session({ block: "B", floor: 3, room: "r", verdict: "thin", frames: 12, usable: 10, gaps: 0 }).photos, 0);
  assert.throws(() => V.session({ block: "B", floor: 3, room: "r", verdict: "thin", frames: 5, usable: 5, gaps: 0, photos: 6 }), V.Invalid);
  assert.throws(() => V.session({ block: "B", floor: 3, room: "r", verdict: "thin", frames: 999, usable: 5, gaps: 0, photos: 251 }), V.Invalid);
  assert.throws(() => V.photoParams("http://x/api/photos?session=4&i=250&w=1&h=1"), V.Invalid);
  assert.deepEqual(V.photoParams("http://x/api/photos?session=4&i=0&w=2048&h=1536"), { session: 4, i: 0, w: 2048, h: 1536, geo: null });
  // where the photo was taken: all three or none
  assert.deepEqual(V.photoParams("http://x/api/photos?session=4&i=0&w=1&h=1&lat=3.05545123&lng=101.7001&acc=8.6").geo, { lat: 3.055451, lng: 101.7001, acc: 9 });
  assert.throws(() => V.photoParams("http://x/api/photos?session=4&i=0&w=1&h=1&lat=3.05&lng=101.7"), V.Invalid);
  assert.throws(() => V.photoParams("http://x/api/photos?session=4&i=0&w=1&h=1&lat=93&lng=101.7&acc=5"), V.Invalid);
  assert.throws(() => V.photoParams("http://x/api/photos?session=4&i=-1&w=1&h=1"), V.Invalid);
  assert.throws(() => V.photoParams("http://x/api/photos?session=x&i=0&w=1&h=1"), V.Invalid);
  assert.equal(V.isJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), true);
  assert.equal(V.isJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), false);
});

test("guests see public places only: the page and the server use the same rule", async () => {
  const { readFileSync } = await import("node:fs");
  const P = await import("../lib/privacy.js");
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  assert.equal(html.match(/const PUBLIC_NAME=(\/.*\/i);/)[1], String(P.PUBLIC_NAME), "PUBLIC_NAME differs between web/index.html and lib/privacy.js");
  assert.equal(html.match(/const PUBLIC_TYPES=new Set\((\[.*?\])\)/)[1].replace(/"/g, "'"), JSON.stringify([...P.PUBLIC_TYPES]).replace(/"/g, "'"));
  const pub = (name, type = "office") => P.isPublic({ name, type });
  for (const n of ["Library", "Auditorium 3", "Cafeteria", "Surau (prayer room)", "Student lounge", "Multipurpose hall"]) assert.ok(pub(n), n);
  for (const n of ["Lecture Theatre 3-1", "Robotics Lab", "Dean's office", "Staff lounge", ""]) assert.ok(!pub(n), n);
  assert.ok(pub("", "toilet") && pub("", "stairs") && !pub("", "lecture"));
  assert.ok(pub("Robotics Lab", "lab") === false && P.isPublic({ name: "Robotics Lab", type: "lab", public: true }));
});

const DB = process.env.TEST_DATABASE_URL;
test("API against Postgres", { skip: !DB && "set TEST_DATABASE_URL to run" }, async t => {
  process.env.DATABASE_URL = DB;
  const { query, closeDb } = await import("../lib/db.js");
  after(closeDb);
  await query("SELECT 1");
  await query("TRUNCATE plan, versions, sessions, photos, video_chunks, recon, workers, users, logins RESTART IDENTITY");
  const KEY = "open sesame", E = { "x-edit-key": KEY };
  process.env.EDIT_KEY = KEY;
  after(() => { delete process.env.EDIT_KEY; });
  const api = name => import(`../api/${name}.js`);
  // Calls send the edit key unless a test passes its own x-edit-key ("" for none), and,
  // once the accounts test has logged in, the student's login (A) unless a test passes its own authorization.
  let A = {};
  const call = async (name, method, body, headers = {}) => {
    const req = new Request(`http://x/api/${name}`, { method, headers: { "content-type": "application/json", ...E, ...A, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await (await api(name.split("?")[0]))[method](new Request(`http://x/api/${name}`, req));
    return { status: res.status, etag: res.headers.get("etag"), body: [204, 304].includes(res.status) ? null : await res.json() };
  };

  await t.test("health reports the database", async () => {
    const r = await call("health", "GET");
    assert.equal(r.body.db, true);
    assert.equal(r.body.editKey, true);
    assert.equal(r.body.editKeySet, true);
    assert.equal(r.body.keyOk, true);
  });

  await t.test("accounts: sign up, log in, 6-hour logins, log out", async () => {
    const auth = (body, headers) => call("auth", "POST", body, headers);
    const reg = await auth({ action: "register", email: " Ana@Uni.edu ", studentId: "tp000001", password: "correct horse" });
    assert.equal(reg.status, 201);
    assert.deepEqual(reg.body.user, { email: "ana@uni.edu", studentId: "TP000001" });
    const hours = (reg.body.expiresAt - Date.now()) / 3600_000;
    assert.ok(hours > 5.9 && hours <= 6, `login lasts 6 hours, not ${hours}`);
    assert.equal((await auth({ action: "register", email: "ana@uni.edu", studentId: "TP9", password: "another one" })).body.field, "email");
    const dupId = await auth({ action: "register", email: "other@uni.edu", studentId: "TP000001", password: "another one" });
    assert.deepEqual([dupId.status, dupId.body.field], [409, "studentId"]);
    assert.equal((await auth({ action: "register", email: "x@uni.edu", studentId: "TP2", password: "short" })).status, 400);
    assert.equal((await auth({ action: "register", email: "not an email", studentId: "TP2", password: "long enough" })).status, 400);
    assert.equal((await auth({ action: "register", studentId: "TP2", password: "long enough" })).status, 400, "email is required");

    assert.equal((await auth({ action: "login", studentId: "TP000001", password: "wrong password" })).status, 401);
    assert.equal((await auth({ action: "login", studentId: "TP404", password: "correct horse" })).status, 401);
    const li = await auth({ action: "login", studentId: "tp000001", password: "correct horse" });
    assert.equal(li.status, 200);
    const bearer = t => ({ authorization: `Bearer ${t}` });
    const me = await call("auth", "GET", undefined, bearer(li.body.token));
    assert.deepEqual([me.status, me.body.user.studentId], [200, "TP000001"]);
    assert.equal((await call("auth", "GET", undefined, bearer("x".repeat(43)))).status, 401);
    assert.equal((await call("auth", "GET")).status, 401, "no login");

    // Logins end after 6 hours
    await query("UPDATE logins SET expires_at = now() - interval '1 second' WHERE user_id = 1");
    assert.equal((await call("auth", "GET", undefined, bearer(li.body.token))).status, 401, "expired");
    const again = await auth({ action: "login", studentId: "TP000001", password: "correct horse" });
    assert.equal((await call("auth", "DELETE", undefined, bearer(again.body.token))).status, 200);
    assert.equal((await call("auth", "GET", undefined, bearer(again.body.token))).status, 401, "logged out");

    // Contributing needs a login; viewing doesn't
    const sess = { block: "B", floor: 3, verdict: "thin", frames: 1, usable: 1, gaps: 0 };
    const guest = await call("sessions", "POST", sess);
    assert.deepEqual([guest.status, guest.body.error], [401, "login"]);
    assert.equal((await call("videos", "POST", { block: "B", floor: 3, bytes: 10, type: "video/mp4" })).status, 401);
    assert.equal((await call("state", "GET")).status, 200, "guests can still view");
    const guestEdit = await call("plan", "PUT", { plan: plan(), baseRev: 0 });
    assert.deepEqual([guestEdit.status, guestEdit.body.error], [401, "login"], "editing needs a login as well as the edit key");
    A = bearer((await auth({ action: "login", studentId: "TP000001", password: "correct horse" })).body.token);
  });

  await t.test("empty state", async () => {
    const r = await call("state", "GET");
    assert.equal(r.status, 200);
    assert.equal(r.body.plan, null);
    assert.deepEqual(r.body.versions, []);
  });

  await t.test("save, conflict, force", async () => {
    const a = await call("plan", "PUT", { plan: plan(), baseRev: 0, note: "First", by: "Ana" });
    assert.equal(a.status, 200); assert.equal(a.body.rev, 1);
    const b = await call("plan", "PUT", { plan: plan([room({ name: "Second" })]), baseRev: 1, note: "Second", by: "Ben" });
    assert.equal(b.body.rev, 2);
    const stale = await call("plan", "PUT", { plan: plan([]), baseRev: 1, note: "Stale", by: "Ana" });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.plan.rev, 2);
    assert.equal(stale.body.plan.rooms[0].name, "Second");
    const forced = await call("plan", "PUT", { plan: plan([]), baseRev: 1, note: "Forced", by: "Ana", force: true });
    assert.equal(forced.body.rev, 3);
  });

  await t.test("concurrent saves from the same base: exactly one wins", async () => {
    const rs = await Promise.all([1, 2, 3, 4].map(i => call("plan", "PUT", { plan: plan(), baseRev: 3, note: "Race " + i, by: "P" + i })));
    assert.deepEqual(rs.map(r => r.status).sort(), [200, 409, 409, 409]);
  });

  await t.test("versions list and fetch", async () => {
    const l = await call("versions", "GET");
    assert.deepEqual(l.body.versions.map(v => v.rev), [4, 3, 2, 1]);
    assert.equal(l.body.versions[0].rooms, 1);
    assert.equal(l.body.versions[0].plan, undefined);
    const v = await call("versions?rev=2", "GET");
    assert.equal(v.body.plan.rooms[0].name, "Second");
    assert.equal((await call("versions?rev=99", "GET")).status, 404);
  });

  await t.test("bad plan is rejected", async () => {
    const r = await call("plan", "PUT", { plan: plan([room({ type: "dungeon" })]), baseRev: 4 });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /room type/);
  });

  await t.test("guests see public places, and only the outline of other rooms", async () => {
    const rooms = [room(), room({ k: "a2", id: "B-03-02", name: "Library", type: "other" }), room({ k: "a3", id: "B-03-03", name: "", type: "toilet" }),
      room({ k: "a4", id: "B-03-04", name: "Open lab", type: "lab", public: true }), room({ k: "a5", id: "B-03-05", name: "Staff lobby", type: "lobby", public: false })];
    const saved = await call("plan", "PUT", { plan: plan(rooms), baseRev: 4, note: "Rooms" });
    assert.equal(saved.status, 200);
    const G = { authorization: "" };
    for (const name of ["state", "plan"]) {
      const g = (await call(name, "GET", undefined, G)).body;
      const [lab, lib, wc, open, staff] = g.plan.rooms;
      assert.deepEqual(lab, { k: "a1", id: "", name: "", type: "other", floor: 3, height: 3.2, poly: rooms[0].poly, doors: rooms[0].doors, private: true }, name);
      assert.deepEqual([lib.id, lib.name, wc.id, wc.type, open.name], ["B-03-02", "Library", "B-03-03", "toilet", "Open lab"], name);
      assert.deepEqual([staff.id, staff.private], ["", true], "an editor can hide a public type");
      assert.equal(g.plan.by, undefined, "who saved it stays hidden");
      if (name === "state") assert.deepEqual([g.versions, g.sessions], [[], []]);
    }
    const full = await call("state", "GET");
    assert.equal(full.body.plan.rooms[0].id, "B-03-01", "logged-in students see every room");
    assert.notEqual(full.etag, (await call("state", "GET", undefined, G)).etag, "guests and students don't share a cached copy");
    assert.equal((await call("versions", "GET", undefined, G)).status, 401);
    assert.equal((await call("versions?rev=1", "GET", undefined, G)).status, 401);
    assert.equal((await call("sessions", "GET", undefined, G)).status, 401);
  });

  await t.test("sessions and ETag", async () => {
    const s0 = await call("state", "GET");
    const same = await call("state", "GET", undefined, { "if-none-match": s0.etag });
    assert.equal(same.status, 304);
    const add = await call("sessions", "POST", { by: "Ana", block: "B", floor: 3, room: "B-03-01", verdict: "accepted", frames: 20, usable: 18, gaps: 0 });
    assert.equal(add.status, 201);
    const s1 = await call("state", "GET", undefined, { "if-none-match": s0.etag });
    assert.equal(s1.status, 200);
    assert.equal(s1.body.sessions[0].room, "B-03-01");
    assert.equal(s1.body.sessions[0].by, "TP000001", "credited to the logged-in student");
    assert.equal(s1.body.sessions[0].geo, null);
    const tagged = await call("sessions", "POST", { block: "B", floor: 3, verdict: "thin", frames: 9, usable: 9, gaps: 0, geo: { lat: 3.0553, lng: 101.7007, acc: 30 } });
    assert.equal(tagged.status, 201);
    assert.deepEqual(tagged.body.geo, { lat: 3.0553, lng: 101.7007, acc: 30 });
  });

  await t.test("photos: reserve, upload, list, fetch", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
    const up = (q, body = jpeg, headers = {}) => api("photos").then(m => m.POST(new Request(`http://x/api/photos?${q}`,
      { method: "POST", headers: { "content-type": "image/jpeg", ...A, ...headers }, body })));
    assert.equal((await call("health", "GET")).body.photos, true);
    const s = await call("sessions", "POST", { by: "Ana", block: "B", floor: 3, room: "B-03-02", verdict: "accepted", frames: 20, usable: 18, gaps: 0, photos: 2 });
    assert.equal(s.body.photoSlots, 2);
    const id = s.body._id;
    const etag = (await call("state", "GET")).etag;
    assert.equal((await up(`session=${id}&i=0&w=4&h=3`)).status, 201);
    assert.equal((await up(`session=${id}&i=0&w=4&h=3`)).status, 409, "same slot twice");
    assert.equal((await up(`session=${id}&i=2&w=4&h=3`)).status, 409, "beyond the reserved slots");
    assert.equal((await up(`session=99999&i=0&w=4&h=3`)).status, 404);
    assert.equal((await up(`session=${id}&i=1&w=4&h=3`, new Uint8Array([1, 2, 3, 4]))).status, 400, "not a JPEG");
    assert.equal((await up(`session=${id}&i=1&w=4&h=3&lat=3.0554512&lng=101.7001234&acc=9`)).status, 201, "with where it was taken");
    const st = await call("state", "GET", undefined, { "if-none-match": etag });
    assert.equal(st.status, 200, "ETag changes when photos arrive");
    assert.equal(st.body.sessions.find(x => x._id === id).photos, 2);
    const list = await call(`photos?session=${id}`, "GET");
    assert.deepEqual(list.body.photos.map(p => [p.i, p.w, p.h, p.bytes]), [[0, 4, 3, 10], [1, 4, 3, 10]]);
    assert.deepEqual(list.body.photos.map(p => p.geo), [null, { lat: 3.055451, lng: 101.700123, acc: 9 }]);
    const res = await (await api("photos")).GET(new Request(`http://x/api/photos?id=${list.body.photos[0].id}`, { headers: E }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/jpeg");
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), jpeg);
    assert.equal((await (await api("photos")).GET(new Request("http://x/api/photos?id=12345", { headers: E }))).status, 404);
    const none = await call("sessions", "POST", { block: "B", floor: 3, room: "B-03-02", verdict: "thin", frames: 9, usable: 9, gaps: 0 });
    assert.equal((await up(`session=${none.body._id}&i=0&w=4&h=3`)).status, 409, "session reserved no photos");
    process.env.PHOTO_UPLOAD = "off";
    try {
      assert.equal((await up(`session=${id}&i=0&w=4&h=3`)).status, 503, "no photo store");
      const off = await call("sessions", "POST", { block: "B", floor: 3, room: "B-03-02", verdict: "thin", frames: 9, usable: 9, gaps: 0, photos: 3 });
      assert.equal(off.body.photoSlots, 0, "no slots without a photo store");
    } finally { delete process.env.PHOTO_UPLOAD; }
  });

  await t.test("jobs: claim, report, reset", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
    const up = (q) => api("photos").then(m => m.POST(new Request(`http://x/api/photos?${q}`, { method: "POST", headers: { "content-type": "image/jpeg", ...A }, body: jpeg })));
    const W = { "x-worker-key": "worker secret" };
    const claim = (q = "", h = W) => call("jobs" + q, "POST", { name: "test-pc", version: "1" }, h);
    const result = { poly: [[0, 0], [7.2, 0], [7.2, 5.4], [0, 5.4]], size: [7.2, 5.4], area: 38.88, height: 3, aligned: true, match: 0.9,
      scale: { source: "marker", confidence: "high", views: 3 }, images: { placed: 9, total: 9 }, points: 5000, notes: [],
      marker: [1, 0], wallPoints: [[0, 1], [7.2, 2]], cameras: [[3, 3]], worker: { version: "1" }, extra: "dropped" };

    assert.equal((await claim("", {})).status, 503, "no WORKER_KEY on the server");
    process.env.WORKER_KEY = "worker secret";
    try {
      assert.equal((await claim("", { "x-worker-key": "nope" })).status, 401);
      const s = await call("sessions", "POST", { block: "B", floor: 3, room: "B-03-01", verdict: "accepted", frames: 9, usable: 9, gaps: 0, photos: 9 });
      const id = s.body._id;
      for (let i = 0; i < 8; i++) assert.equal((await up(`session=${id}&i=${i}&w=4&h=3`)).status, 201);
      assert.equal((await claim()).status, 204, "uploads not finished yet");
      await up(`session=${id}&i=8&w=4&h=3`);
      const j = await claim();
      assert.equal(j.status, 200);
      assert.equal(j.body.job.session._id, id);
      assert.equal(j.body.job.photos.length, 9);
      assert.equal(j.body.job.room.id, "B-03-01");
      assert.equal(j.body.job.marker, "APU|B|03|B-03-01");
      assert.equal((await claim()).status, 204, "already being processed");

      const photo = id => api("photos").then(m => m.GET(new Request(`http://x/api/photos?id=${id}`, { headers: W })));
      assert.equal((await photo(j.body.job.photos[0].id)).status, 200, "the worker can fetch photos with its own key");

      assert.equal((await call(`jobs?session=${id}`, "PUT", { status: "done", result: { ...result, poly: [[0, 0]] } }, W)).status, 400);
      const rev0 = (await call("plan", "GET")).body.plan.rev;
      const done = await call(`jobs?session=${id}`, "PUT", { status: "done", result }, W);
      assert.equal(done.status, 200);
      assert.equal((await call(`jobs?session=${id}`, "PUT", { status: "done", result }, W)).status, 409, "not claimed any more");
      // The measured outline goes straight onto the drawn room, as a new plan revision
      assert.equal(done.body.imported.action, "replaced");
      assert.equal(done.body.imported.room, "B-03-01");
      assert.equal(done.body.imported.placed, "room");
      assert.equal(done.body.imported.rev, rev0 + 1);
      const p1 = (await call("plan", "GET")).body;
      assert.equal(p1.plan.rev, rev0 + 1);
      const r1 = p1.plan.rooms.find(r => r.id === "B-03-01" && r.floor === 3);
      assert.deepEqual(r1.poly, [[0, 0], [7.2, 0], [7.2, 5.4], [0, 5.4]]);
      assert.equal(r1.height, 3);
      assert.match((await call("versions", "GET")).body.versions[0].note, /Worker measured session/);
      const st = await call("state", "GET");
      assert.equal(st.body.sessions.find(x => x._id === id).recon.result.imported.room, "B-03-01", "the outcome is kept with the measurement");
      const rec = st.body.sessions.find(x => x._id === id).recon;
      assert.equal(rec.status, "done");
      assert.equal(rec.result.area, 38.88);
      assert.equal(rec.result.wallPoints, undefined, "point lists stay out of /api/state");
      assert.equal(rec.result.extra, undefined);
      assert.equal(st.body.worker.name, "test-pc");
      const full = await call(`jobs?session=${id}`, "GET");
      assert.deepEqual(full.body.recon.result.wallPoints, [[0, 1], [7.2, 2]]);

      assert.equal((await call(`jobs?session=${id}`, "DELETE")).status, 200);
      assert.equal((await claim()).status, 200, "measured again after a reset");
      assert.equal((await call(`jobs?session=${id}`, "PUT", { status: "failed", error: "Too blurry" }, W)).status, 200);
      const failed = (await call("state", "GET")).body.sessions.find(x => x._id === id).recon;
      assert.deepEqual([failed.status, failed.error], ["failed", "Too blurry"]);
      assert.equal((await claim()).status, 204, "failed sessions wait for a reset");
      assert.equal((await claim(`?session=${id}`)).status, 200, "unless asked for by ID");
    } finally { delete process.env.WORKER_KEY; }
  });

  await t.test("walk videos: upload, worker maps it, the map is added to the plan by GPS", async () => {
    const W = { "x-worker-key": "worker secret" };
    const video = (method, q, body, headers = {}) => call("videos" + q, method, body, headers);
    const start = { by: "Ana", block: "B", floor: 7, bytes: 9_000_000, type: "video/mp4", name: "floor.mp4", geo: { lat: 3.05545, lng: 101.70012, acc: 12 } };
    // Raw pieces of the video, the way the browser sends them
    const part = (id, i, bytes, headers = {}) => import("../api/videos.js").then(m => m.PUT(new Request(`http://x/api/videos?session=${id}&i=${i}`,
      { method: "PUT", headers: { "content-type": "application/octet-stream", ...E, ...A, ...headers }, body: bytes })))
      .then(async r => ({ status: r.status, body: await r.json() }));
    const getPart = (id, i, headers) => import("../api/videos.js").then(m => m.GET(new Request(`http://x/api/videos?session=${id}&i=${i}`, { headers })));
    const fill = (n, v) => new Uint8Array(n).fill(v);
    process.env.WORKER_KEY = "worker secret";
    try {
      assert.equal((await call("health", "GET")).body.videos, true, "on whenever a database is connected");
      const s = await video("POST", "", start, { "x-edit-key": "" });
      assert.equal(s.status, 201, "contributors don't need the edit key");
      assert.equal(s.body.kind, "map");
      assert.deepEqual(s.body.video, { bytes: 9_000_000, type: "video/mp4", parts: 3, uploaded: false, deleted: false, file: "floor.mp4" });
      const id = s.body._id;
      assert.equal((await video("POST", "", { ...start, type: "image/png" })).status, 400);
      assert.equal((await video("POST", "", { ...start, bytes: 900_000_000 })).status, 400, "too big for the database");

      assert.equal((await part(id, 0, fill(10, 1))).status, 400, "pieces are 4 MB but the last");
      assert.equal((await part(id, 3, fill(1_000_000, 1))).status, 400, "only 3 pieces");
      assert.equal((await part("99999", 0, fill(10, 1))).status, 404);
      let p = await part(id, 0, fill(4_000_000, 1), { "x-edit-key": "" });
      assert.equal(p.status, 200);
      assert.deepEqual([p.body.received, p.body.ready], [1, false]);
      assert.equal((await part(id, 2, fill(1_000_000, 3))).body.ready, false, "out of order is fine");
      assert.equal((await call("jobs", "POST", { name: "pc" }, W)).status, 204, "not uploaded yet");
      assert.equal((await getPart(id, 0, W)).status, 404, "not until it's all there");
      p = await part(id, 1, fill(4_000_000, 2));
      assert.deepEqual([p.body.received, p.body.ready], [3, true]);
      assert.equal((await part(id, 1, fill(4_000_000, 2))).status, 409, "no second upload");
      assert.equal((await getPart(id, 1, { "x-edit-key": "" })).status, 401, "viewers can't fetch videos");
      const info = await video("GET", `?session=${id}`, undefined, W);
      assert.deepEqual([info.body.parts, info.body.chunk, info.body.ready], [3, 4_000_000, true]);
      const got = new Uint8Array(await (await getPart(id, 1, W)).arrayBuffer());
      assert.equal(got.length, 4_000_000);
      assert.equal(got[123], 2);

      const j = await call("jobs", "POST", { name: "pc", version: "1" }, W);
      assert.equal(j.status, 200);
      assert.equal(j.body.job.kind, "map");
      assert.equal(j.body.job.session._id, id);
      assert.deepEqual(j.body.job.session.geo, start.geo);
      const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      const result = { kind: "map", floor: null, block: null, length: 30,
        regions: [{ id: null, type: "corridor", poly: rect(0, 5, 20, 7.4), doors: [{ e: 0, t: 0.25, w: 0.9 }] },
          { id: "B-07-02", type: "other", poly: rect(3, 0, 8, 5), doors: [{ e: 2, t: 0.5, w: 0.9 }] }],
        path: [[1, 6], [5, 6], [5, 2], [5, 6], [19, 6]], scale: { source: "phone_height", confidence: "medium" },
        images: { placed: 90, total: 92 }, notes: ["A note"], worker: { version: "1" } };
      assert.equal((await call(`jobs?session=${id}`, "PUT", { status: "done", result: { ...result, kind: "walk" } }, W)).status, 400);
      const before = (await call("state", "GET")).body.plan;
      const done = await call(`jobs?session=${id}`, "PUT", { status: "done", result }, W);
      assert.equal(done.status, 200);
      assert.equal(done.body.imported.placed, "gps");
      assert.equal(done.body.imported.rev, before.rev + 1);
      const st = (await call("state", "GET")).body;
      assert.equal(st.plan.rev, before.rev + 1);
      assert.ok(st.plan.rooms.some(r => r.id === "B-07-HALL" && r.floor === 7 && r.type === "corridor"));
      assert.ok(st.plan.rooms.some(r => r.id === "B-07-02" && r.doors.length === 1));
      assert.ok(st.plan.floors.some(f => f.level === 7));
      assert.match(st.versions[0].note, /Worker mapped session \d+/);
      assert.equal(st.versions[0].by, "Worker pc");
      const rec = st.sessions.find(x => x._id === id).recon;
      assert.equal(rec.status, "done");
      assert.equal(rec.result.imported.rev, before.rev + 1);
      assert.equal(rec.result.regions, undefined, "outlines stay out of /api/state");
      assert.equal((await call(`jobs?session=${id}`, "GET")).body.recon.result.regions.length, 2);
      // Once it's on the plan, the video is deleted to free database space
      assert.equal(st.sessions.find(x => x._id === id).video.deleted, true);
      assert.equal((await getPart(id, 0, W)).status, 410);
      assert.equal((await call(`jobs?session=${id}`, "DELETE")).status, 409, "can't be mapped again without the video");
    } finally { delete process.env.WORKER_KEY; }
  });

  await t.test("edit key: only editors change the plan, anyone can contribute", async () => {
    const V0 = { "x-edit-key": "" };
    const no = await call("plan", "PUT", { plan: plan(), baseRev: 4 }, V0);
    assert.equal(no.status, 401);
    assert.equal((await call("plan", "PUT", { plan: plan(), baseRev: 4 }, { "x-edit-key": "wrong" })).status, 401);
    const s = await call("sessions", "POST", { block: "B", floor: 3, room: "x", verdict: "accepted", frames: 1, usable: 1, gaps: 0, photos: 1 }, V0);
    assert.equal(s.status, 201, "viewers can submit sessions");
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
    const up = await (await api("photos")).POST(new Request(`http://x/api/photos?session=${s.body._id}&i=0&w=4&h=3`,
      { method: "POST", headers: { "content-type": "image/jpeg", ...A }, body: jpeg }));
    assert.equal(up.status, 201, "and upload their photos");
    const guestUp = await (await api("photos")).POST(new Request(`http://x/api/photos?session=${s.body._id}&i=0&w=4&h=3`,
      { method: "POST", headers: { "content-type": "image/jpeg" }, body: jpeg }));
    assert.equal(guestUp.status, 401, "but not without logging in");
    assert.equal((await call("plan", "GET", undefined, V0)).status, 200, "and view the plan");
    const yes = await call("plan", "PUT", { plan: plan(), baseRev: (await call("plan", "GET")).body.plan.rev });
    assert.equal(yes.status, 200);
    assert.equal((await call("photos?session=1", "GET", undefined, V0)).status, 401, "viewing photos needs the key");
    assert.equal((await call("jobs?session=1", "DELETE", undefined, V0)).status, 401, "so does resetting a measurement");
    const h = await call("health", "GET", undefined, { "x-edit-key": "wrong" });
    assert.equal(h.body.editKey, true); assert.equal(h.body.keyOk, false);
    delete process.env.EDIT_KEY;
    try {
      const off = await call("plan", "PUT", { plan: plan(), baseRev: 5 });
      assert.equal(off.status, 503, "without EDIT_KEY nobody can edit");
      assert.equal(off.body.error, "no_edit_key");
      const h2 = await call("health", "GET");
      assert.equal(h2.body.editKeySet, false); assert.equal(h2.body.keyOk, false);
    } finally { process.env.EDIT_KEY = KEY; }
  });
});
