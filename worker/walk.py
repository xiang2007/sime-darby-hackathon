"""Trace a corridor from a walk along it: the camera path becomes the corridor, door signs become rooms.

Steps:
  1. COLMAP (see floorplan.run_sfm) works out where each frame was taken. Frames are in walking order.
  2. Up and the floor come from floorplan.up_floor_ceiling, refined by the walk itself: you walk on a
     level floor, so the camera path lies in a horizontal plane.
  3. Scale: the phone is held about 1.45 m above the floor. For a video, the walking pace (about
     1.25 m/s) gives a second estimate to check against.
  4. The path is squared up to the building's main directions and split into straight runs. Each run's
     two walls are the densest layers of 3D points on either side of it, which gives the corridor width.
  5. Door signs ("B-03-02") are read with OCR when it's installed, and door QR markers always. The line
     of sight from the camera to the sign is followed to the corridor wall, and a door goes there.
  6. Each sign gets a placeholder room behind its door, so Directions can route to it straight away.
     People then fix the room's real size on the Floor plan, or measure it from photos.

All lengths are in metres, in floor-plan coordinates (x right, y down on screen).
"""
from __future__ import annotations

import logging
import math
import re
from collections import Counter, defaultdict
from pathlib import Path

import cv2
import numpy as np

from floorplan import (GRID, PHONE_HEIGHT, ReconError, _gather, _layers, _manhattan_angle, _rot, area, corners,
                       rectilinear, up_floor_ceiling)

WALK_PACE = 1.25           # m/s, same as WALK_MPS in web/index.html
DEFAULT_HALF = 1.0         # half the corridor width when a wall can't be found
ROOM_W, ROOM_D = 4.0, 4.0  # placeholder room behind each door sign
DOOR_W = 0.9
MAX_DOORS = 50             # the server keeps at most 50 doors per room
SIGN = re.compile(r"(?<![A-Z0-9])([A-Z]{1,2})\s*[-–—.]\s*(\d{1,2})\s*[-–—.]\s*(\d{1,3}[A-Z]?)(?![A-Z0-9])")


# ---------------------------------------------------------------- reading door signs

def room_code(text: str):
    """'B-03-02', 'b - 3 - 2' or a door marker 'APU|B|03|B-03-02' -> ('B-03-02', 'B', 3), else None."""
    t = (text or "").strip()
    if t.startswith("APU|"):
        parts = t.split("|")
        t = parts[3] if len(parts) == 4 else ""
    m = SIGN.search(t.upper())
    if not m:
        return None
    blk, fl, num = m.group(1), int(m.group(2)), m.group(3)
    if num.isdigit():
        num = num.zfill(2)
    return f"{blk}-{fl:02d}-{num}", blk, fl


class SignReader:
    """QR door markers (OpenCV) and, if rapidocr is installed, printed door signs."""

    def __init__(self, ocr=True, log=print):
        self.qr = cv2.QRCodeDetector()
        self.ocr = None
        if ocr:
            try:
                logging.getLogger("RapidOCR").setLevel(logging.WARNING)
                from rapidocr import RapidOCR
                self.ocr = RapidOCR(params={"Global.log_level": "warning"}) if _accepts_params(RapidOCR) else RapidOCR()
                logging.getLogger("RapidOCR").setLevel(logging.WARNING)
            except Exception as e:      # not installed, or the models couldn't load
                log(f"Door-sign OCR is off ({type(e).__name__}: {e}). Install it with: pip install rapidocr onnxruntime")

    def read(self, path: Path):
        """[(code, block, floor, (u, v) pixel centre, source)] for one image."""
        im = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if im is None:
            return []
        out = []
        try:
            text, pts, _ = self.qr.detectAndDecode(cv2.cvtColor(im, cv2.COLOR_BGR2GRAY))
        except cv2.error:
            text, pts = "", None
        if text and pts is not None and (c := room_code(text)):
            out.append((*c, tuple(pts.reshape(-1, 2).mean(0)), "marker"))
        if self.ocr is not None:
            s = min(1.0, 1600 / max(im.shape[:2]))
            small = cv2.resize(im, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s < 1 else im
            try:
                r = self.ocr(small)
            except Exception:
                r = None
            txts, boxes, scores = getattr(r, "txts", None), getattr(r, "boxes", None), getattr(r, "scores", None)
            for txt, box, sc in zip(txts or (), boxes if boxes is not None else (), scores or ()):
                c = room_code(txt)
                if c and sc >= 0.6 and not any(o[0] == c[0] for o in out):
                    out.append((*c, tuple(np.asarray(box, float).reshape(-1, 2).mean(0) / s), "sign"))
        return out


def _accepts_params(cls):
    try:
        import inspect
        return "params" in inspect.signature(cls.__init__).parameters
    except (TypeError, ValueError):
        return False


# ---------------------------------------------------------------- path → straight runs

def _rdp(P, eps):
    """Ramer–Douglas–Peucker: indices of the points kept."""
    keep = np.zeros(len(P), bool)
    keep[[0, -1]] = True
    stack = [(0, len(P) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        a, b = P[i], P[j]
        d = b - a
        L = np.hypot(*d)
        seg = P[i + 1:j] - a
        dist = np.abs(seg[:, 0] * d[1] - seg[:, 1] * d[0]) / L if L > 1e-9 else np.hypot(seg[:, 0], seg[:, 1])
        k = int(np.argmax(dist))
        if dist[k] > eps:
            keep[i + 1 + k] = True
            stack += [(i, i + 1 + k), (i + 1 + k, j)]
    return np.flatnonzero(keep)


def straight_runs(xy, min_run=1.5):
    """Split a walk (n×2, squared to the axes) into straight runs along x or y.
    Returns [{horiz, c, idx}]: c is the run's centre line (y for horizontal runs, x for vertical ones)
    and idx the walk samples on it."""
    keep = _rdp(xy, 0.6)
    runs = []
    for i, j in zip(keep[:-1], keep[1:]):
        d = xy[j] - xy[i]
        horiz = abs(d[0]) >= abs(d[1])
        idx = np.arange(i, j + 1)
        runs.append({"horiz": horiz, "idx": idx, "len": float(np.hypot(*d))})

    def merge(R):
        out = []
        for r in R:
            if out and out[-1]["horiz"] == r["horiz"]:
                out[-1] = {"horiz": r["horiz"], "idx": np.union1d(out[-1]["idx"], r["idx"]), "len": out[-1]["len"] + r["len"]}
            else:
                out.append(dict(r))
        return out

    runs = merge(runs)
    while len(runs) > 1:                       # a short sidestep isn't a corridor of its own
        k = min(range(len(runs)), key=lambda i: runs[i]["len"])
        if runs[k]["len"] >= min_run:
            break
        nb = [i for i in (k - 1, k + 1) if 0 <= i < len(runs)]
        n = max(nb, key=lambda i: runs[i]["len"])
        runs[n]["idx"] = np.union1d(runs[n]["idx"], runs[k]["idx"])
        del runs[k]
        runs = merge(runs)
    for r in runs:
        a = xy[r["idx"], 1 if r["horiz"] else 0]
        r["c"] = float(np.median(a))
    return runs


def _centre_line(runs, xy):
    """Corner points of the squared walk, start to end."""
    def pt(r, along):
        return [along, r["c"]] if r["horiz"] else [r["c"], along]
    first, last = runs[0], runs[-1]
    out = [pt(first, xy[0, 0 if first["horiz"] else 1])]
    for a, b in zip(runs[:-1], runs[1:]):
        out.append([b["c"], a["c"]] if a["horiz"] else [a["c"], b["c"]])
    out.append(pt(last, xy[-1, 0 if last["horiz"] else 1]))
    return np.array(out)


def find_walls(run, xy, pts, lo, hi):
    """Distances from the run's centre line to the wall on each side ('-' and '+' across), or None."""
    along = pts[:, 0] if run["horiz"] else pts[:, 1]
    across = (pts[:, 1] if run["horiz"] else pts[:, 0]) - run["c"]
    m = (along > lo + 0.3) & (along < hi - 0.3) & (np.abs(across) < 3.5)
    out = []
    for sign in (-1, 1):
        x = across[m] * sign
        x = x[(x > 0.35) & (x < 3.5)]
        if len(x) < 20:
            out.append(None)
            continue
        cnt, edges = np.histogram(x, np.arange(0.35, 3.51, 0.05))
        sm = np.convolve(cnt, [1, 2, 1], "same")
        j = int(np.argmax(sm))
        peak = (edges[j] + edges[j + 1]) / 2
        near = x[np.abs(x - peak) < 0.08]
        out.append(float(np.median(near)) if len(near) >= max(15, 0.15 * len(x)) else None)
    return out


def find_end(run, pts, at, outward):
    """How far past `at` (along the run, in direction outward = ±1) the corridor's end wall is, or None."""
    along = pts[:, 0] if run["horiz"] else pts[:, 1]
    across = (pts[:, 1] if run["horiz"] else pts[:, 0]) - run["c"]
    m = (across > -run["walls"][0] + 0.2) & (across < run["walls"][1] - 0.2)
    x = (along[m] - at) * outward
    x = x[(x > 0.2) & (x < 6.0)]
    if len(x) < 20:
        return None
    cnt, edges = np.histogram(x, np.arange(0.2, 6.01, 0.05))
    j = int(np.argmax(np.convolve(cnt, [1, 2, 1], "same")))
    near = x[np.abs(x - (edges[j] + edges[j + 1]) / 2) < 0.08]
    return float(np.median(near)) if len(near) >= max(15, 0.15 * len(x)) else None


# ---------------------------------------------------------------- doors and placeholder rooms

def _exit(poly, c, d, max_s=15.0):
    """Where the ray c + s·d (s > 0) leaves the polygon: (s, edge, t along the edge), or None."""
    best = None
    for e in range(len(poly)):
        a, b = poly[e], poly[(e + 1) % len(poly)]
        ab = b - a
        den = d[0] * -ab[1] - d[1] * -ab[0]
        if abs(den) < 1e-9:
            continue
        rhs = a - c
        s = (rhs[0] * -ab[1] - rhs[1] * -ab[0]) / den
        t = (d[0] * rhs[1] - d[1] * rhs[0]) / den
        if 0.05 < s < max_s and -1e-6 <= t <= 1 + 1e-6 and (best is None or s < best[0]):
            best = (float(s), e, float(np.clip(t, 0, 1)))
    return best


def _inside(pt, poly):
    return cv2.pointPolygonTest(np.asarray(poly, np.float32).reshape(-1, 1, 2), (float(pt[0]), float(pt[1])), False) > 0


def _outward(poly, e):
    a, b = poly[e], poly[(e + 1) % len(poly)]
    d = (b - a) / max(np.hypot(*(b - a)), 1e-9)
    n = np.array([d[1], -d[0]])
    mid = (a + b) / 2
    return n if not _inside(mid + 0.05 * n, poly) else -n


def place_doors(poly, hits, notes=None):
    """hits: code -> [(s, edge, t)]. One door per code, on the wall the sign was seen on most.
    Two signs read within 1.2 m of each other are most likely one sign misread, so the one seen less is dropped."""
    doors = []
    for code, hs in hits.items():
        hs = sorted(hs, key=lambda h: h[0])[:max(3, len(hs) // 2)]   # the closest views are the most exact
        edge = Counter(h[1] for h in hs).most_common(1)[0][0]
        a, b = poly[edge], poly[(edge + 1) % len(poly)]
        L = float(np.hypot(*(b - a)))
        if L < DOOR_W + 0.1:
            continue
        t = float(np.median([h[2] for h in hs if h[1] == edge]))
        x = _triangulate([(h[3], h[4]) for h in hs])
        if x is not None:                      # seen from different angles: where the sight lines cross
            u = (b - a) / L
            v = x - a
            if abs(float(u[0] * v[1] - u[1] * v[0])) < 1.0:
                t = float(np.clip((x - a) @ u / L, 0, 1))
        half = DOOR_W / 2 / L
        t = min(max(t, half), 1 - half)
        doors.append({"code": code, "e": edge, "t": round(t, 4), "views": len(hits[code]), "at": a + (b - a) * t})
    kept = []
    for d in sorted(doors, key=lambda d: (-d["views"], d["code"])):
        other = next((k for k in kept if np.hypot(*(k["at"] - d["at"])) < 1.2), None)
        if other is None:
            kept.append(d)
        elif notes is not None:
            notes.append(f"{d['code']} was read once next to {other['code']}, so it was taken as a misread of it.")
    return sorted(kept, key=lambda d: (d["e"], d["t"]))


def _triangulate(rays, min_angle=8.0):
    """Least-squares crossing point of 2D sight lines [(origin, unit direction)], or None if they're too parallel."""
    if len(rays) < 2:
        return None
    ang = [math.atan2(d[1], d[0]) for _, d in rays]
    spread = max(abs((x - y + math.pi) % (2 * math.pi) - math.pi) for x in ang for y in ang)
    if math.degrees(spread) < min_angle:
        return None
    A, b = np.zeros((2, 2)), np.zeros(2)
    for c, d in rays:
        M = np.eye(2) - np.outer(d, d)
        A += M
        b += M @ c
    return np.linalg.solve(A, b)


def placeholder_rooms(poly, doors, notes):
    """A ROOM_W × ROOM_D box behind each door, narrower where doors are close together, and shallower
    where it would run into the corridor or another room."""
    taken = []
    rooms = []
    by_edge = defaultdict(list)
    for d in doors:
        by_edge[d["e"]].append(d)
    for e, ds in by_edge.items():
        a, b = poly[e], poly[(e + 1) % len(poly)]
        L = float(np.hypot(*(b - a)))
        u = (b - a) / L
        n = _outward(poly, e)
        ds.sort(key=lambda d: d["t"])
        pos = [d["t"] * L for d in ds]
        for i, d in enumerate(ds):
            left = pos[i] - pos[i - 1] if i else 1e9
            right = pos[i + 1] - pos[i] if i + 1 < len(ds) else 1e9
            w = min(ROOM_W, left, right)
            if w < 1.2:
                notes.append(f"The {d['code']} sign is under 1.2 m from the next one, so no room was added for it.")
                continue
            lo_, hi_ = max(-w / 2, -pos[i]), min(w / 2, L - pos[i])   # keep the room's wall along the corridor wall
            c = a + u * pos[i]
            for depth in (ROOM_D, 3.0, 2.0, 1.5):
                q = np.array([c + u * lo_, c + u * hi_, c + u * hi_ + n * depth, c + u * lo_ + n * depth])
                shrunk = q + (q.mean(0) - q) * 0.02
                if not any(_inside(p, poly) for p in shrunk) and not any(_overlap(shrunk, o) for o in taken):
                    break
            else:
                notes.append(f"There was no room behind the {d['code']} sign for a placeholder room.")
                continue
            taken.append(q)
            rooms.append({"id": d["code"], "poly": q, "door": {"e": 0, "t": round(float(-lo_ / (hi_ - lo_)), 4)}})
    return rooms


def _overlap(p, q):
    a0, b0 = p.min(0), p.max(0)
    a1, b1 = q.min(0), q.max(0)
    return bool(np.all(a0 < b1) and np.all(a1 < b0))


# ---------------------------------------------------------------- all together

def _floor(P, C, c0, up):
    """Height of the floor along up: the densest flat layer of points well below every camera, or None."""
    h, cam = (P - c0) @ up, (C - c0) @ up
    lo, hi = np.percentile(h, [1, 99])
    span = float(hi - lo) or 1.0               # about floor to ceiling
    w = span / 150
    below = [x for x in _layers(h, span, max(15, int(0.002 * len(P)))) if x < cam.min() - 0.1 * span]
    return max(below, key=lambda x: int((np.abs(h - x) < 2 * w).sum())) if below else None


def walk_frame(recs, times=None):
    """The walk in metres, on the floor plane, squared up to the building: cameras in walking order, 3D points,
    and which points are on the walls. Up comes from the walk's plane, scale from phone height checked against
    walking pace. Shared by --walk and --map."""
    imgs, poses, C, P, obs_p, obs_c = _gather(recs)
    order = np.argsort([Path(im.name).name for im in imgs], kind="stable")
    imgs = [imgs[i] for i in order]
    poses = [poses[i] for i in order]
    C = C[order]
    notes = []

    up, c0, floor, _, _ = up_floor_ceiling(poses, C, P)
    _, sv, vt = np.linalg.svd(C - C.mean(0))
    if sv[1] > 0.2 * sv[0]:                    # the walk turned a corner: its plane gives "up" more exactly
        n = vt[2] if vt[2] @ up > 0 else -vt[2]
        if n @ up > math.cos(math.radians(20)):
            up = n
            floor = _floor(P, C, c0, up)
    floor_found = floor is not None
    if not floor_found:
        floor = float(np.percentile((P - c0) @ up, 1))
    cam_h = float(np.median((C - c0) @ up)) - floor

    e1 = np.cross(up, [1.0, 0, 0])
    if np.linalg.norm(e1) < 0.1:
        e1 = np.cross(up, [0, 0, 1.0])
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(e1, up)
    flat = lambda X: np.stack([np.asarray(X) @ e1, np.asarray(X) @ e2], axis=-1)

    # scale: phone height, checked against walking pace when the frames have times
    s_height = PHONE_HEIGHT / cam_h if cam_h > 1e-9 else None
    s_pace = None
    if times:
        t = np.array([times.get(Path(im.name).name, np.nan) for im in imgs], float)
        ok = ~np.isnan(t)
        if ok.sum() >= 5 and t[ok].max() - t[ok].min() >= 5:
            xy = flat(C[ok] - c0)
            k = max(1, ok.sum() // 15)          # skip sway: measure over a few frames at a time
            dist = float(np.hypot(*np.diff(xy[::k], axis=0).T).sum())
            dur = float(t[ok][::k][-1] - t[ok][::k][0])
            if dist > 0 and dur > 0:
                s_pace = WALK_PACE * dur / dist
    if floor_found and s_height:
        s = s_height
        scale = {"source": "phone_height", "confidence": "low"}
        if s_pace:
            r = s_pace / s_height
            if 0.8 <= r <= 1.25:
                scale["confidence"] = "medium"
                notes.append(f"Phone height and walking pace agree on the scale to within {abs(r - 1) * 100:.0f}%.")
            else:
                notes.append(f"Walking pace suggests distances {r:.2f}× of those shown (from phone height). "
                             "If you stopped or hurried on the way, trust phone height.")
        scale["pace_ratio"] = round(s_pace / s_height, 3) if s_pace else None
    elif s_pace:
        s = s_pace
        scale = {"source": "walking_pace", "confidence": "low", "pace_ratio": 1.0}
        notes.append("The floor wasn't visible enough, so distances assume you walked at about 1.25 m/s.")
    else:
        s = s_height or 1.0
        scale = {"source": "phone_height", "confidence": "low", "pace_ratio": None}
        notes.append("The floor wasn't visible enough, so distances are rough. Tilt the phone down a little while walking.")

    Pm = flat(P - c0) * s
    Ph = ((P - c0) @ up - floor) * s
    Cm = flat(C - c0) * s
    band = (Ph > 0.5) & (Ph < 2.4)
    theta = _manhattan_angle(Pm[band] if band.sum() >= 200 else Cm)
    Rm = _rot(theta)
    pts, cams = Pm @ Rm.T, Cm @ Rm.T
    wall_pts = pts[band]
    return dict(imgs=imgs, poses=poses, C=C, P=P, obs_p=obs_p, obs_c=obs_c, flat=flat, Rm=Rm, pts=pts, cams=cams,
                band=band, heights=Ph, wall_pts=wall_pts, scale=scale, notes=notes)


def trace_walk(recs, image_dir: Path, *, times=None, ocr=True, floor_level=None, block=None, work: Path | None = None, log=print):
    """recs: from floorplan.run_sfm. times: {image basename: seconds into the video}, if known."""
    F = walk_frame(recs, times)
    imgs, poses, C, P, notes, flat, Rm, pts, cams, wall_pts, scale = (F[k] for k in
        ("imgs", "poses", "C", "P", "notes", "flat", "Rm", "pts", "cams", "wall_pts", "scale"))

    # the walk, smoothed and squared up
    k = 2
    sm = np.array([np.median(cams[max(0, i - k):i + k + 1], axis=0) for i in range(len(cams))])
    length = float(np.hypot(*np.diff(sm, axis=0).T).sum())
    if length < 3:
        raise ReconError(f"The walk is only {length:.1f} m long. Walk at least 5 m along the corridor.")
    runs = straight_runs(sm)
    line = _centre_line(runs, sm)

    # each straight run becomes a rectangle as wide as its walls
    for i, r in enumerate(runs):
        ax = 0 if r["horiz"] else 1
        lo, hi = float(line[i][ax]), float(line[i + 1][ax])
        lo, hi = min(lo, hi), max(lo, hi)
        a = sm[r["idx"], ax]
        r["lo"], r["hi"] = min(lo, float(a.min())), max(hi, float(a.max()))
        w = find_walls(r, sm, wall_pts, r["lo"], r["hi"])
        r["walls"] = [x if x is not None else DEFAULT_HALF for x in w]
        r["found"] = [x is not None for x in w]
    # the corridor goes on past where the walk started and stopped, up to its end walls if they were seen
    for r, i, j in ((runs[0], 0, 1), (runs[-1], -1, -2)):
        ax = 0 if r["horiz"] else 1
        out = 1.0 if line[i][ax] >= line[j][ax] else -1.0
        at = float(cams[r["idx"], ax].max() if out > 0 else cams[r["idx"], ax].min())   # the outermost frame
        d = find_end(r, wall_pts, at, out)
        end = at + out * (d if d is not None else 0.5)
        r["lo"], r["hi"] = min(r["lo"], end), max(r["hi"], end)
    missing = sum(not f for r in runs for f in r["found"])
    if missing:
        notes.append(f"{missing} of {2 * len(runs)} corridor walls weren't clear in the photos, so they're drawn "
                     f"{DEFAULT_HALF:.1f} m from where you walked. Point the phone at the walls a little more.")
    rects = []
    for r in runs:
        m0, m1 = r["c"] - r["walls"][0], r["c"] + r["walls"][1]
        rects.append([r["lo"], m0, r["hi"], m1] if r["horiz"] else [m0, r["lo"], m1, r["hi"]])
    # stretch each run's ends to the far wall of the run it turns into, so the corners are filled
    for i, r in enumerate(runs):
        ax = 0 if r["horiz"] else 1
        for j in (i - 1, i + 1):
            if 0 <= j < len(runs):
                o = runs[j]
                lo_o, hi_o = o["c"] - o["walls"][0], o["c"] + o["walls"][1]
                if abs(o["c"] - rects[i][ax]) < abs(o["c"] - rects[i][ax + 2]):
                    rects[i][ax] = min(rects[i][ax], lo_o)
                else:
                    rects[i][ax + 2] = max(rects[i][ax + 2], hi_o)

    allr = np.array(rects)
    lo = np.array([allr[:, 0].min(), allr[:, 1].min()]) - 0.5
    hi = np.array([allr[:, 2].max(), allr[:, 3].max()]) + 0.5
    shape = (int((hi[1] - lo[1]) / GRID) + 1, int((hi[0] - lo[0]) / GRID) + 1)
    if shape[0] * shape[1] > 20_000_000:
        raise ReconError("The walk spreads over too large an area. Record one corridor at a time.")
    mask = np.zeros(shape, np.uint8)
    for x0, y0, x1, y1 in rects:
        a = np.round((np.array([x0, y0]) - lo) / GRID).astype(int)
        b = np.round((np.array([x1, y1]) - lo) / GRID).astype(int)
        mask[a[1]:b[1], a[0]:b[0]] = 1
    cs, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cnt = max(cs, key=cv2.contourArea)
    approx = cnt.reshape(-1, 2) * GRID + lo
    E = rectilinear(approx, min_edge=0.3)
    poly = corners(E) if E else cv2.approxPolyDP(cnt, 0.1 / GRID, True).reshape(-1, 2) * GRID + lo
    if area(poly) < 2:
        raise ReconError("The traced corridor is under 2 m², which can't be right.")

    # door signs → doors on the corridor wall
    reader = SignReader(ocr=ocr, log=log)
    hits, seen, blocks, floors = defaultdict(list), Counter(), Counter(), Counter()
    log(f"Reading door signs in {len(imgs)} frames…")
    for k, im in enumerate(imgs):
        for code, blk, fl, (u, v), src in reader.read(image_dir / im.name):
            seen[(code, src)] += 1
            blocks[blk] += 1
            floors[fl] += 1
            xy = np.asarray(im.camera.cam_from_img(np.array([[u, v]], float))).reshape(-1)[:2]
            R, _ = poses[k]
            d3 = R.T @ np.array([xy[0], xy[1], 1.0])
            d = flat(d3[None])[0] @ Rm.T
            if np.hypot(*d) < 0.2:
                continue                       # looking straight up or down
            d /= np.hypot(*d)
            if not _inside(cams[k], poly):
                continue
            h = _exit(poly, cams[k], d)
            if h:
                hits[code].append((*h, cams[k].copy(), d))
    codes = sorted({c for c, _ in seen})
    if codes:
        log("Signs read: " + ", ".join(f"{c} ({sum(n for (cc, _), n in seen.items() if cc == c)}×)" for c in codes))
    doors = place_doors(poly, hits, notes)
    if len(doors) > MAX_DOORS:
        notes.append(f"{len(doors)} door signs were read; only the {MAX_DOORS} seen most often were kept.")
        doors = sorted(doors, key=lambda d: -d["views"])[:MAX_DOORS]
    rooms = placeholder_rooms(poly, doors, notes)
    if not doors:
        notes.append("No door signs were read, so the corridor has no doors yet. Film each door sign for a second "
                     "on the way, or add doors on the Floor plan.")

    floor_level = floor_level if floor_level is not None else (floors.most_common(1)[0][0] if floors else None)
    block = block or (blocks.most_common(1)[0][0] if blocks else None)
    if floor_level is None:
        notes.append("The floor number wasn't given or read from a sign; choose it when you import the walk.")

    # shift everything so the walk's corner sits at (0, 0)
    allp = np.vstack([poly] + [r["poly"] for r in rooms])
    off = -allp.min(0)
    rnd = lambda A: np.round(np.asarray(A) + off, 2).tolist()
    result = {
        "kind": "walk",
        "block": block,
        "floor": floor_level,
        "length": round(length, 1),
        "corridor": {"poly": rnd(poly), "doors": [{"e": d["e"], "t": d["t"], "w": DOOR_W, "room": d["code"]} for d in doors],
                     "width": round(float(np.median([sum(r["walls"]) for r in runs])), 2), "area": round(area(poly), 1)},
        "rooms": [{"id": r["id"], "poly": rnd(r["poly"]), "doors": [{"e": r["door"]["e"], "t": r["door"]["t"], "w": DOOR_W}],
                   "placeholder": True} for r in rooms],
        "signs": [{"room": c, "seen": sum(n for (cc, _), n in seen.items() if cc == c),
                   "source": "marker" if (c, "marker") in seen else "sign", "door": any(d["code"] == c for d in doors)} for c in codes],
        "path": rnd(line),
        "scale": scale,
        "images": {"placed": len(imgs)},
        "points": int(len(P)),
        "notes": notes,
    }
    sub = wall_pts if len(wall_pts) <= 2000 else wall_pts[np.random.default_rng(0).choice(len(wall_pts), 2000, replace=False)]
    result["wallPoints"] = rnd(sub)
    result["cameras"] = rnd(cams)
    if work is not None:
        _preview(work / "preview.png", np.asarray(result["corridor"]["poly"]), [np.asarray(r["poly"]) for r in result["rooms"]],
                 [r["id"] for r in result["rooms"]], np.asarray(result["wallPoints"]), np.asarray(result["cameras"]),
                 np.asarray(result["path"]), result["corridor"]["doors"])
    return result


def _preview(path, poly, rooms, names, pts, cams, line, doors):
    allp = np.vstack([poly, *rooms, cams]) if rooms else np.vstack([poly, cams])
    lo = allp.min(0) - 1
    s = 40                                     # pixels per metre
    size = ((allp.max(0) + 1 - lo) * s).astype(int)
    img = np.full((size[1], size[0], 3), 255, np.uint8)
    px = lambda X: ((np.asarray(X) - lo) * s).astype(np.int32)
    for q, name in zip(rooms, names):
        cv2.fillPoly(img, [px(q)], (230, 240, 225))
        cv2.polylines(img, [px(q)], True, (120, 160, 110), 1)
        c = px(q.mean(0))
        cv2.putText(img, name, (int(c[0]) - 40, int(c[1]) + 5), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (60, 90, 60), 1, cv2.LINE_AA)
    cv2.fillPoly(img, [px(poly)], (235, 225, 210))
    for p in px(pts):
        cv2.circle(img, (int(p[0]), int(p[1])), 1, (90, 90, 90), -1)
    cv2.polylines(img, [px(poly)], True, (40, 40, 220), 2)
    cv2.polylines(img, [px(line)], False, (200, 120, 30), 2)
    for p in px(cams):
        cv2.circle(img, (int(p[0]), int(p[1])), 3, (200, 120, 30), -1)
    for d in doors:
        a, b = poly[d["e"]], poly[(d["e"] + 1) % len(poly)]
        c = px(a + (b - a) * d["t"])
        cv2.circle(img, (int(c[0]), int(c[1])), 6, (40, 170, 40), -1)
    cv2.imwrite(str(path), img)
