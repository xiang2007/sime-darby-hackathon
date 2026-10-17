// API tests. The database tests need a throwaway Postgres:
//   TEST_DATABASE_URL=postgres://user:pass@localhost/apu_test npm test
// They wipe the plan, versions, sessions and photos tables. Photos go to a temporary folder.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as V from "../lib/validate.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const room = (over = {}) => ({ k: "a1", id: "B-03-01", name: "Lab", type: "lab", floor: 3, height: 3.2,
  poly: [[0, 0], [4, 0], [4, 3], [0, 3]], doors: [{ e: 0, t: 0.5, w: 0.9 }], ...over });
const plan = (rooms = [room()]) => ({ block: "B", floors: [{ level: 3, name: "Level 3" }], rooms });

test("plan validation keeps known fields and drops the rest", () => {
  const p = V.plan({ ...plan([room({ evil: "<script>", stair: { kind: "switchback", dir: 2, mirror: true, x: 1 } })]), extra: 1 });
  assert.deepEqual(Object.keys(p), ["block", "floors", "rooms"]);
  assert.equal(p.rooms[0].evil, undefined);
  assert.deepEqual(p.rooms[0].stair, { kind: "switchback", dir: 2, mirror: true });
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
  assert.throws(() => V.session({ block: "B", floor: 3, room: "", verdict: "thin", frames: 1, usable: 1, gaps: 0 }), V.Invalid);
});

test("photo validation", () => {
  assert.equal(V.session({ block: "B", floor: 3, room: "r", verdict: "thin", frames: 12, usable: 10, gaps: 0, photos: 10 }).photos, 10);
  assert.equal(V.session({ block: "B", floor: 3, room: "r", verdict: "thin", frames: 12, usable: 10, gaps: 0 }).photos, 0);
  assert.throws(() => V.session({ block: "B", floor: 3, room: "r", verdict: "thin", frames: 5, usable: 5, gaps: 0, photos: 6 }), V.Invalid);
  assert.throws(() => V.session({ block: "B", floor: 3, room: "r", verdict: "thin", frames: 999, usable: 5, gaps: 0, photos: 201 }), V.Invalid);
  assert.deepEqual(V.photoParams("http://x/api/photos?session=4&i=0&w=2048&h=1536"), { session: 4, i: 0, w: 2048, h: 1536 });
  assert.throws(() => V.photoParams("http://x/api/photos?session=4&i=200&w=1&h=1"), V.Invalid);
  assert.throws(() => V.photoParams("http://x/api/photos?session=4&i=-1&w=1&h=1"), V.Invalid);
  assert.throws(() => V.photoParams("http://x/api/photos?session=x&i=0&w=1&h=1"), V.Invalid);
  assert.equal(V.isJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), true);
  assert.equal(V.isJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), false);
});

const DB = process.env.TEST_DATABASE_URL;
test("API against Postgres", { skip: !DB && "set TEST_DATABASE_URL to run" }, async t => {
  process.env.DATABASE_URL = DB;
  const { query, closeDb } = await import("../lib/db.js");
  after(closeDb);
  await query("SELECT 1");
  await query("TRUNCATE plan, versions, sessions, photos RESTART IDENTITY");
  const photoDir = await mkdtemp(join(tmpdir(), "photos-"));
  process.env.LOCAL_PHOTO_DIR = photoDir;
  after(() => rm(photoDir, { recursive: true, force: true }));
  const api = name => import(`../api/${name}.js`);
  const call = async (name, method, body, headers = {}) => {
    const req = new Request(`http://x/api/${name}`, { method, headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await (await api(name.split("?")[0]))[method](new Request(`http://x/api/${name}`, req));
    return { status: res.status, etag: res.headers.get("etag"), body: res.status === 304 ? null : await res.json() };
  };

  await t.test("health reports the database", async () => {
    const r = await call("health", "GET");
    assert.equal(r.body.db, true);
    assert.equal(r.body.editKey, false);
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

  await t.test("sessions and ETag", async () => {
    const s0 = await call("state", "GET");
    const same = await call("state", "GET", undefined, { "if-none-match": s0.etag });
    assert.equal(same.status, 304);
    const add = await call("sessions", "POST", { by: "Ana", block: "B", floor: 3, room: "B-03-01", verdict: "accepted", frames: 20, usable: 18, gaps: 0 });
    assert.equal(add.status, 201);
    const s1 = await call("state", "GET", undefined, { "if-none-match": s0.etag });
    assert.equal(s1.status, 200);
    assert.equal(s1.body.sessions[0].room, "B-03-01");
    assert.equal(s1.body.sessions[0].by, "Ana");
  });

  await t.test("photos: reserve, upload, list, fetch", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
    const up = (q, body = jpeg, headers = {}) => api("photos").then(m => m.POST(new Request(`http://x/api/photos?${q}`,
      { method: "POST", headers: { "content-type": "image/jpeg", ...headers }, body })));
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
    assert.equal((await up(`session=${id}&i=1&w=4&h=3`)).status, 201);
    const st = await call("state", "GET", undefined, { "if-none-match": etag });
    assert.equal(st.status, 200, "ETag changes when photos arrive");
    assert.equal(st.body.sessions.find(x => x._id === id).photos, 2);
    const list = await call(`photos?session=${id}`, "GET");
    assert.deepEqual(list.body.photos.map(p => [p.i, p.w, p.h, p.bytes]), [[0, 4, 3, 10], [1, 4, 3, 10]]);
    const res = await (await api("photos")).GET(new Request(`http://x/api/photos?id=${list.body.photos[0].id}`));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/jpeg");
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), jpeg);
    assert.equal((await (await api("photos")).GET(new Request("http://x/api/photos?id=12345"))).status, 404);
    const none = await call("sessions", "POST", { block: "B", floor: 3, room: "B-03-02", verdict: "thin", frames: 9, usable: 9, gaps: 0 });
    assert.equal((await up(`session=${none.body._id}&i=0&w=4&h=3`)).status, 409, "session reserved no photos");
    delete process.env.LOCAL_PHOTO_DIR;
    try {
      assert.equal((await up(`session=${id}&i=0&w=4&h=3`)).status, 503, "no photo store");
      const off = await call("sessions", "POST", { block: "B", floor: 3, room: "B-03-02", verdict: "thin", frames: 9, usable: 9, gaps: 0, photos: 3 });
      assert.equal(off.body.photoSlots, 0, "no slots without a photo store");
    } finally { process.env.LOCAL_PHOTO_DIR = photoDir; }
  });

  await t.test("edit key", async () => {
    process.env.EDIT_KEY = "open sesame";
    try {
      const no = await call("plan", "PUT", { plan: plan(), baseRev: 4 });
      assert.equal(no.status, 401);
      const s = await call("sessions", "POST", { block: "B", floor: 3, room: "x", verdict: "thin", frames: 1, usable: 1, gaps: 0 });
      assert.equal(s.status, 401);
      const yes = await call("plan", "PUT", { plan: plan(), baseRev: 4 }, { "x-edit-key": "open sesame" });
      assert.equal(yes.status, 200);
      assert.equal((await call("photos?session=1", "GET")).status, 401, "photos need the key too");
      const h = await call("health", "GET", undefined, { "x-edit-key": "wrong" });
      assert.equal(h.body.editKey, true); assert.equal(h.body.keyOk, false);
    } finally { delete process.env.EDIT_KEY; }
  });
});
