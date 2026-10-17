#!/usr/bin/env python3
"""UCampass(PIC) reconstruction worker. Runs on your own computer, not on Vercel.

It asks the website for capture sessions whose photos have been uploaded, measures each
room from its photos (see floorplan.py), and sends the outline and height back. The result
shows up on the Floor plan tab, where someone can compare it with the drawn room and apply it.

  Connected to the website (keeps running, checks for new sessions every 20 seconds):
    python worker.py --server https://your-app.vercel.app --key WORKER_KEY

  One session again, even if it was already done:
    python worker.py --server ... --key ... --session 42

  Offline, on a zip saved from Sessions → View → Download all:
    python worker.py --photos session-42-B-03-02.zip [--plan plan.json] [--room B-03-02]
"""
from __future__ import annotations

import argparse
import json
import platform
import shutil
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from floorplan import ReconError, measure, prepare_images, run_sfm  # noqa: E402

VERSION = "1"


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


class Api:
    def __init__(self, server, key):
        self.base = server.rstrip("/")
        self.key = key

    def call(self, method, path, body=None, raw=False):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={
            "x-worker-key": self.key, "content-type": "application/json", "user-agent": f"ucampass-worker/{VERSION}"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                payload = r.read()
                if raw:
                    return payload
                return json.loads(payload) if payload else None
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read()).get("message")
            except Exception:
                msg = None
            raise RuntimeError(f"{method} {path}: HTTP {e.code} {msg or e.reason}") from None


def marker_text(plan, room_id):
    room = next((r for r in plan.get("rooms", []) if r.get("id") == room_id), None) if plan else None
    if not room:
        return None, None
    return room, f"APU|{plan.get('block') or ''}|{str(room['floor']).zfill(2)}|{room['id']}"


def process(files, room, marker, keep: Path | None = None):
    work = Path(tempfile.mkdtemp(prefix="ucampass-"))
    try:
        images = work / "images"
        prepare_images(files, images)
        rec = run_sfm(images, work, log=log)
        result = measure(rec, images, room=room, marker_text=marker, work=work, log=log)
        total, placed = len(files), result["images"]["placed"]
        result["images"]["total"] = total
        if placed < 0.8 * total:
            result["notes"].insert(0, f"Only {placed} of {total} photos could be linked together, so part of the room may be "
                                      "missing from the outline. Take photos closer together, especially when turning at corners.")
        result["worker"] = {"version": VERSION}
        if keep:
            keep.mkdir(parents=True, exist_ok=True)
            for f in ("preview.png",):
                if (work / f).exists():
                    shutil.copy(work / f, keep / f)
        return result
    finally:
        shutil.rmtree(work, ignore_errors=True)


def summary(r):
    s = f"{r['size'][0]:.2f} × {r['size'][1]:.2f} m, {r['area']:.1f} m²"
    if r.get("height"):
        s += f", height {r['height']:.2f} m"
    s += f" (scale from {'door marker' if r['scale']['source'] == 'marker' else 'phone height'}, {r['scale']['confidence']} confidence)"
    return s


def run_offline(args):
    src = Path(args.photos)
    files, meta = [], {}
    if src.is_dir():
        files = [(p.name, p.read_bytes()) for p in sorted(src.glob("*.jpg"))]
        if (src / "session.json").exists():
            meta = json.loads((src / "session.json").read_text())
    else:
        with zipfile.ZipFile(src) as z:
            for n in sorted(z.namelist()):
                if n.lower().endswith(".jpg"):
                    files.append((Path(n).name, z.read(n)))
                elif n == "session.json":
                    meta = json.loads(z.read(n))
    plan = json.loads(Path(args.plan).read_text()) if args.plan else None
    if plan and "plan" in plan and "rooms" not in plan:
        plan = plan["plan"]
    room, marker = marker_text(plan, args.room or meta.get("room"))
    if args.plan and not room:
        log(f"Room {args.room or meta.get('room')} isn't in {args.plan}, so the outline won't be placed over it.")
    log(f"{len(files)} photos")
    out = Path(args.out or "result.json")
    result = process(files, room, marker, keep=out.parent)
    out.write_text(json.dumps(result, indent=1))
    log("Measured:", summary(result))
    for n in result["notes"]:
        log("Note:", n)
    log(f"Saved {out} and {out.parent / 'preview.png'}")


def run_server(args):
    api = Api(args.server, args.key)
    name = args.name or platform.node() or "worker"
    log(f"Worker '{name}' connected to {api.base}. Waiting for sessions with uploaded photos… (Ctrl+C to stop)")
    while True:
        try:
            q = f"?session={args.session}" if args.session else ""
            job = api.call("POST", "/api/jobs" + q, {"name": name, "version": VERSION})
        except Exception as e:
            log("Couldn't reach the website:", e)
            if args.once:
                sys.exit(1)
            time.sleep(30)
            continue
        if not job or not job.get("job"):
            if args.once or args.session:
                log("Nothing to do.")
                return
            time.sleep(20)
            continue
        j = job["job"]
        sid = j["session"]["_id"]
        log(f"Session {sid}: room {j['session']['room']}, {len(j['photos'])} photos")
        try:
            files = [(f"{p['i']:03d}.jpg", api.call("GET", f"/api/photos?id={p['id']}", raw=True)) for p in j["photos"]]
            result = process(files, j.get("room"), j.get("marker"))
            api.call("PUT", f"/api/jobs?session={sid}", {"status": "done", "result": result})
            log(f"Session {sid} done:", summary(result))
        except ReconError as e:
            log(f"Session {sid} failed:", e)
            api.call("PUT", f"/api/jobs?session={sid}", {"status": "failed", "error": str(e)})
        except Exception as e:
            traceback.print_exc()
            try:
                api.call("PUT", f"/api/jobs?session={sid}", {"status": "failed", "error": f"Worker error: {e}"[:300]})
            except Exception:
                pass
        if args.once or args.session:
            return


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--server", help="the website, e.g. https://your-app.vercel.app")
    ap.add_argument("--key", help="WORKER_KEY, as set on the website")
    ap.add_argument("--name", help="name shown on the website (default: this computer's name)")
    ap.add_argument("--session", help="process this session even if it was done before")
    ap.add_argument("--once", action="store_true", help="process at most one session, then stop")
    ap.add_argument("--photos", help="offline: a zip or folder of photos")
    ap.add_argument("--plan", help="offline: the plan JSON exported from the Floor plan tab")
    ap.add_argument("--room", help="offline: the room ID (default: from session.json in the zip)")
    ap.add_argument("--out", help="offline: where to write the result (default result.json)")
    args = ap.parse_args()
    if args.photos:
        return run_offline(args)
    if not args.server or not args.key:
        ap.error("pass --server and --key, or --photos for offline use")
    run_server(args)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
