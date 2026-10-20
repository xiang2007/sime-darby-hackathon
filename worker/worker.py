#!/usr/bin/env python3
"""UCampass(PIC) reconstruction worker. Runs on your own computer, not on Vercel.

It asks the website for capture sessions whose photos or walk video have been uploaded.
Photos: it measures the room (see floorplan.py) and sends the outline and height back; the result
shows up on the Floor plan tab, where someone can compare it with the drawn room and apply it.
Walk videos (Contribute → Map a whole floor): it downloads the video from the website (kept in its Neon database),
maps the floor (see floormap.py) and sends the map back. The website adds it to the floor plan straight
away, placed by the session's GPS, as Floor plan → Import walk or map would.

  Connected to the website (keeps running, checks for new sessions every 20 seconds):
    python worker.py --server https://your-app.vercel.app --key WORKER_KEY

  One session again, even if it was already done:
    python worker.py --server ... --key ... --session 42

  Offline, on a zip saved from Sessions → View → Download all:
    python worker.py --photos session-42-B-03-02.zip [--plan plan.json] [--room B-03-02]

  Offline, on a walk-through video (frames are picked the way the app picks photos):
    python worker.py --video walk.mp4 [--fps 2] [--max-frames 80] [--plan plan.json] [--room B-03-02]

  Offline, trace a corridor from a walk along it (video or photos). Door signs become rooms.
  Import the walk.json it writes on the Floor plan tab (Import walk):
    python worker.py --walk --video corridor.mp4 [--floor 3] [--block B] [--no-ocr]

  Offline, map a floor from one walk along the hallway and into each room: rooms, hallways and the doors
  between them, all where they really are. Import the map.json it writes on the Floor plan tab (Import walk):
    python worker.py --map --video floor.mp4 [--floor 4] [--block B] [--no-ocr]
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import sys
import tempfile
import time
import traceback
import types
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from floorplan import ReconError, measure, prepare_images, run_sfm  # noqa: E402
from video import VideoError, extract_frames  # noqa: E402
from floormap import map_floor  # noqa: E402
from walk import trace_walk  # noqa: E402

VERSION = "2"


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


class Api:
    def __init__(self, server, key, bypass=None):
        self.base = server.rstrip("/")
        self.key = key
        # Vercel Deployment Protection: a preview deployment (or a protected production one) answers 401 to
        # anyone not signed in to Vercel. Its "Protection Bypass for Automation" secret lets the worker through.
        self.bypass = bypass

    def headers(self, extra=None):
        h = {"x-worker-key": self.key, "user-agent": f"ucampass-worker/{VERSION}"}
        if self.bypass:
            h["x-vercel-protection-bypass"] = self.bypass
        return {**h, **(extra or {})}

    def call(self, method, path, body=None, raw=False, timeout=60):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=self.headers({"content-type": "application/json"}))
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                payload = r.read()
                if raw:
                    return payload
                return json.loads(payload) if payload else None
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read()).get("message")
            except Exception:
                msg = None
            if e.code == 401 and not msg:
                msg = ("blocked by Vercel Deployment Protection. Use the production address, or pass --bypass "
                       "with the project's Protection Bypass for Automation secret")
            raise RuntimeError(f"{method} {path}: HTTP {e.code} {msg or e.reason}") from None

    def download_video(self, session_id, dest: Path):
        """Save a session's walk video to dest. The website keeps it in its Neon database in pieces of a few MB
        (a Vercel function sends at most 4.5 MB at a time), so fetch them in order and join them up."""
        info = self.call("GET", f"/api/videos?session={session_id}")
        if info.get("deleted"):
            raise RuntimeError("The video was deleted after it was mapped. Upload it again from Contribute.")
        if not info.get("ready"):
            raise RuntimeError(f"The video hasn't finished uploading ({info.get('received', 0)} of {info['parts']} pieces).")
        total, parts, done, last = int(info["bytes"]), int(info["parts"]), 0, time.time()
        with open(dest, "wb") as f:
            for i in range(parts):
                for attempt in range(4):
                    try:
                        data = self.call("GET", f"/api/videos?session={session_id}&i={i}", raw=True, timeout=120)
                        break
                    except (RuntimeError, OSError) as e:
                        if attempt == 3 or "HTTP 4" in str(e):
                            raise RuntimeError(f"Couldn't download piece {i + 1} of {parts}: {e}") from None
                        time.sleep(2 ** (attempt + 1))
                f.write(data)
                done += len(data)
                if time.time() - last > 10:
                    log(f"  downloaded {done / 1e6:.0f} of {total / 1e6:.0f} MB")
                    last = time.time()
        if done != total:
            raise RuntimeError(f"The video download came to {done} bytes, not {total}.")
        return done


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


def process_walk(files, times, args, keep: Path | None = None):
    work = Path(tempfile.mkdtemp(prefix="ucampass-walk-"))
    try:
        images = work / "images"
        prepare_images(files, images)
        rec = run_sfm(images, work, log=log, sequential=True)
        result = (map_floor if args.map else trace_walk)(rec, images, times=times, ocr=not args.no_ocr, floor_level=args.floor,
                                                          block=args.block, work=work, log=log)
        total, placed = len(files), result["images"]["placed"]
        result["images"]["total"] = total
        if placed < 0.8 * total:
            result["notes"].insert(0, f"Only {placed} of {total} frames could be linked together, so part of the walk may be "
                                      "missing. Walk more slowly, and turn slowly at corners.")
        result["worker"] = {"version": VERSION}
        if keep:
            keep.mkdir(parents=True, exist_ok=True)
            if (work / "preview.png").exists():
                shutil.copy(work / "preview.png", keep / "preview.png")
        return result
    finally:
        shutil.rmtree(work, ignore_errors=True)


def walk_summary(r):
    c = r["corridor"]
    s = f"{r['length']:.1f} m walked, corridor {c['area']:.0f} m² about {c['width']:.1f} m wide, {len(c['doors'])} door(s)"
    if r["rooms"]:
        s += ": " + ", ".join(x["id"] for x in r["rooms"])
    return s + f" (scale from {r['scale']['source'].replace('_', ' ')}, {r['scale']['confidence']} confidence)"


def map_summary(r):
    rs = r["regions"]
    halls = [x for x in rs if x["type"] in ("corridor", "lobby")]
    s = f"{r['length']:.1f} m walked, {len(halls)} hallway(s) and {len(rs) - len(halls)} room(s), {r['doors']} door(s)"
    named = [x["id"] for x in rs if x["id"]]
    if named:
        s += ": " + ", ".join(named)
    return s + f" (scale from {r['scale']['source'].replace('_', ' ')}, {r['scale']['confidence']} confidence)"


def summary(r):
    s = f"{r['size'][0]:.2f} × {r['size'][1]:.2f} m, {r['area']:.1f} m²"
    if r.get("height"):
        s += f", height {r['height']:.2f} m"
    s += f" (scale from {'door marker' if r['scale']['source'] == 'marker' else 'phone height'}, {r['scale']['confidence']} confidence)"
    return s


def load_photos(src: Path):
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
    return files, meta


def run_offline(args):
    files, meta, times = [], {}, None
    max_frames = args.max_frames or (360 if args.map else 150 if args.walk else 80)
    fps = args.fps or (3.0 if args.map else 2.0)     # --map: more frames, so quick turns at doors don't break the walk
    if args.video:
        files, stats = extract_frames(args.video, fps=fps, max_frames=max_frames, ffmpeg=args.ffmpeg, log=log)
        times = stats["times"]
        if len(files) < 8:
            raise VideoError(f"Only {len(files)} usable frames; at least 8 are needed. Film more slowly and steadily, with better light.")
    else:
        files, meta = load_photos(Path(args.photos))
    if args.walk or args.map:
        log(f"{len(files)} frames")
        out = Path(args.out or ("map.json" if args.map else "walk.json"))
        result = process_walk(files, times, args, keep=out.parent)
        out.write_text(json.dumps(result, indent=1))
        log("Mapped:" if args.map else "Traced:", (map_summary if args.map else walk_summary)(result))
        for n in result["notes"]:
            log("Note:", n)
        log(f"Saved {out} and {out.parent / 'preview.png'}. Import {out.name} on the Floor plan tab.")
        return
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
    api = Api(args.server, args.key, args.bypass or os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET"))
    name = args.name or platform.node() or "worker"
    log(f"Worker '{name}' connected to {api.base}. Waiting for sessions with uploaded photos or walk videos… (Ctrl+C to stop)")
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
        try:
            if j.get("kind") == "map":
                run_map_job(api, j, args)
            else:
                log(f"Session {sid}: room {j['session']['room']}, {len(j['photos'])} photos")
                files = [(f"{p['i']:03d}.jpg", api.call("GET", f"/api/photos?id={p['id']}", raw=True)) for p in j["photos"]]
                result = process(files, j.get("room"), j.get("marker"))
                api.call("PUT", f"/api/jobs?session={sid}", {"status": "done", "result": result})
                log(f"Session {sid} done:", summary(result))
        except (ReconError, VideoError) as e:
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


PLACED = {"gps": "placed by the session's GPS", "rooms": "lined up with the rooms already on the plan",
          "beside": "beside the other rooms (no GPS)", "origin": "on an empty floor (no GPS)"}


def run_map_job(api, j, args):
    """A walk video from the website: download it, map the floor, send the map back (the website adds it to the plan)."""
    s = j["session"]
    sid = s["_id"]
    v = j.get("video") or {}
    where = f"Block {s['block']} " if s.get("block") else ""
    gps = f", GPS ±{s['geo']['acc']} m" if s.get("geo") else ", no GPS"
    log(f"Session {sid}: walk video for {where}L{s['floor']} ({(v.get('bytes') or 0) / 1e6:.0f} MB{gps})")
    work = Path(tempfile.mkdtemp(prefix="ucampass-video-"))
    try:
        ext = {"video/quicktime": ".mov", "video/webm": ".webm"}.get(v.get("type"), ".mp4")
        path = work / f"session-{sid}{ext}"
        n = api.download_video(sid, path)
        log(f"Downloaded {n / 1e6:.0f} MB")
        files, stats = extract_frames(path, fps=args.fps or 3.0, max_frames=args.max_frames or 360, ffmpeg=args.ffmpeg, log=log)
        if len(files) < 8:
            raise VideoError(f"Only {len(files)} usable frames; at least 8 are needed. Film more slowly and steadily, with better light.")
        log(f"{len(files)} frames")
        opts = types.SimpleNamespace(map=True, no_ocr=args.no_ocr, floor=s["floor"], block=(s.get("block") or None))
        result = process_walk(files, stats["times"], opts)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    r = api.call("PUT", f"/api/jobs?session={sid}", {"status": "done", "result": result})
    log(f"Session {sid} mapped:", map_summary(result))
    for note in result["notes"]:
        log("Note:", note)
    imp = (r or {}).get("imported") or {}
    if imp.get("error"):
        log(f"Session {sid}: not added to the plan:", imp["error"])
    elif imp:
        what = (f"added {', '.join(imp['added'])}" if imp.get("added") else "") + \
               (f"{'; ' if imp.get('added') else ''}updated {', '.join(imp['replaced'])}" if imp.get("replaced") else "")
        log(f"Session {sid}: on the floor plan as revision r{imp['rev']}, {PLACED.get(imp.get('placed'), imp.get('placed'))}"
            + (f" in {imp['building']}" if imp.get("building") else "") + (f": {what}" if what else "") + ".")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--server", help="the website, e.g. https://your-app.vercel.app")
    ap.add_argument("--key", help="WORKER_KEY, as set on the website")
    ap.add_argument("--bypass", help="Vercel Protection Bypass for Automation secret, if the deployment is protected "
                    "(default: $VERCEL_AUTOMATION_BYPASS_SECRET)")
    ap.add_argument("--name", help="name shown on the website (default: this computer's name)")
    ap.add_argument("--session", help="process this session even if it was done before")
    ap.add_argument("--once", action="store_true", help="process at most one session, then stop")
    ap.add_argument("--photos", help="offline: a zip or folder of photos")
    ap.add_argument("--video", help="offline: a walk-through video; frames are extracted with ffmpeg")
    ap.add_argument("--fps", type=float, default=None, help="offline video: frames to extract per second (default 2; 3 with --map)")
    ap.add_argument("--max-frames", type=int, help="offline video: most frames to use (default 80 like Live camera, 150 with --walk, 360 with --map)")
    ap.add_argument("--ffmpeg", help="offline video: path to ffmpeg if it isn't on PATH")
    ap.add_argument("--plan", help="offline: the plan JSON exported from the Floor plan tab")
    ap.add_argument("--room", help="offline: the room ID (default: from session.json in the zip)")
    ap.add_argument("--out", help="offline: where to write the result (default result.json, walk.json with --walk, map.json with --map)")
    ap.add_argument("--walk", action="store_true", help="offline: trace the corridor walked along, instead of measuring one room")
    ap.add_argument("--map", action="store_true", help="offline: map the hallways, the rooms off them and their doors from one walk")
    ap.add_argument("--floor", type=int, help="--walk: floor number (default: read from the door signs)")
    ap.add_argument("--block", help="--walk: block letter (default: read from the door signs)")
    ap.add_argument("--no-ocr", action="store_true", help="--walk: don't read printed door signs, only QR door markers")
    args = ap.parse_args()
    if (args.walk or args.map) and not (args.photos or args.video):
        ap.error("--walk and --map need --video or --photos")
    if args.walk and args.map:
        ap.error("pass --walk or --map, not both")
    if args.photos or args.video:
        try:
            return run_offline(args)
        except (VideoError, ReconError) as e:
            sys.exit(str(e))
    if not args.server or not args.key:
        ap.error("pass --server and --key, or --photos / --video for offline use")
    run_server(args)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
