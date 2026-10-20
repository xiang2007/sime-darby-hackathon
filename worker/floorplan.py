"""Measure a room from a set of overlapping photos.

Steps:
  1. COLMAP (pycolmap) works out where each photo was taken and builds a sparse 3D point cloud.
  2. "Up" comes from how the phone was held, refined by fitting the floor.
  3. Floor and ceiling are the lowest and highest dense layers of points.
  4. Real-world scale comes from the printed door marker (its size is known). Without one, the
     usual phone height (about 1.45 m above the floor) is used, which is rougher.
  5. The walls: the space the camera could see through is carved out on a 5 cm grid, squared
     up to the room's main directions, and each wall is snapped to the points found on it.
  6. The outline is placed over the room as drawn on the plan, for comparison.

All lengths in the result are in metres, in floor-plan coordinates (x right, y down on screen).
"""
from __future__ import annotations

import math
import os
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np
import pycolmap

import colmap_gpu

GRID = 0.05            # metres per cell when carving free space
PHONE_HEIGHT = 1.45    # typical height of a phone above the floor, for the fallback scale
MARKER_MM = 64.0       # printed size of the marker's QR area, quiet zone included (see markerSvgFile in web/index.html)
QR_M_BYTES = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213]   # byte capacity per QR version at error level M


class ReconError(Exception):
    """A failure worth showing to people as is."""


# ---------------------------------------------------------------- 1. camera positions and points

def run_sfm(image_dir: Path, work: Path, log=print, sequential=False) -> list:
    """Run COLMAP on the photos. Photos of the same size are assumed to share one camera (lens).
    sequential: the photos are in walking order (a video), so each is matched only with its neighbours."""
    names = sorted(str(p.relative_to(image_dir)) for p in image_dir.rglob("*.jpg"))
    if len(names) < 6:
        raise ReconError(f"Only {len(names)} photos. At least 6 are needed, ideally 30 or more.")
    db = work / "database.db"
    if db.exists():
        db.unlink()
    exhaustive = len(names) <= 120 and not sequential
    if colmap_gpu.enabled():
        log(f"Finding features in {len(names)} photos on the GPU…")
        try:
            colmap_gpu.extract_and_match(db, image_dir, names, exhaustive, log)
        except (OSError, RuntimeError) as e:
            log(f"The GPU step failed, so the CPU is used instead. {e}")
            if db.exists():
                db.unlink()
        else:
            return _map(db, image_dir, work, names, log)
    sift = pycolmap.SiftExtractionOptions()
    sift.max_image_size = 2048
    sift.max_num_features = 8192
    sift.estimate_affine_shape = True            # copes better with walls seen at a slant
    sift.domain_size_pooling = True
    reader = pycolmap.ImageReaderOptions()
    reader.default_focal_length_factor = 0.8     # phone main cameras; uploads carry no EXIF to read it from
    log(f"Finding features in {len(names)} photos…")
    pycolmap.extract_features(db, image_dir, image_names=names, camera_mode=pycolmap.CameraMode.PER_FOLDER,
                              camera_model="SIMPLE_RADIAL", reader_options=reader, sift_options=sift)
    log("Matching photos…")
    match = pycolmap.SiftMatchingOptions()
    match.guided_matching = True
    if exhaustive:
        pycolmap.match_exhaustive(db, sift_options=match)
    else:
        seq = pycolmap.SequentialMatchingOptions()
        seq.overlap = 20
        seq.quadratic_overlap = True
        pycolmap.match_sequential(db, sift_options=match, matching_options=seq)
    return _map(db, image_dir, work, names, log)


def _map(db: Path, image_dir: Path, work: Path, names: list, log) -> list:
    log("Working out where each photo was taken…")
    out = work / "sparse"
    out.mkdir(exist_ok=True)
    maps = pycolmap.incremental_mapping(db, image_dir, out)
    if not maps:
        raise ReconError("The photos couldn't be matched to each other. Take them closer together, with more overlap.")
    recs = merge_models(list(maps.values()), log)
    placed = len({im.name for r in recs for im in (r.images[i] for i in r.reg_image_ids())})
    log(f"Placed {placed} of {len(names)} photos in {len(recs)} linked group(s), {sum(len(r.points3D) for r in recs)} points.")
    if placed < 6:
        raise ReconError(f"Only {placed} photos could be placed. Take them closer together, with more overlap.")
    return recs


def _sim3(A, B):
    """Scale s, rotation R, shift t with s R A + t ≈ B (Umeyama)."""
    mu_a, mu_b = A.mean(0), B.mean(0)
    U, S, Vt = np.linalg.svd((B - mu_b).T @ (A - mu_a) / len(A))
    D = np.eye(3)
    D[2, 2] = np.sign(np.linalg.det(U @ Vt))
    R = U @ D @ Vt
    sc = float(np.trace(np.diag(S) @ D) / (((A - mu_a) ** 2).sum() / len(A)))
    return sc, R, mu_b - sc * R @ mu_a


def _shared_points(rec, kept):
    """3D points the two sides both triangulated from the same keypoint of a shared photo."""
    by_name = {}
    for k in kept:
        for i in k.reg_image_ids():
            by_name.setdefault(k.images[i].name, (k, k.images[i]))
    A, B = [], []
    for i in rec.reg_image_ids():
        im = rec.images[i]
        if im.name not in by_name:
            continue
        k, other = by_name[im.name]
        for j, (p, q) in enumerate(zip(im.points2D, other.points2D)):
            if p.has_point3D() and q.has_point3D():
                A.append(rec.points3D[p.point3D_id].xyz)
                B.append(k.points3D[q.point3D_id].xyz)
    return np.array(A), np.array(B)


def merge_models(recs, log=print):
    """COLMAP can split a walk into groups that share some photos. Bring each group that shares
    enough points into the largest group's frame. Groups that don't line up are left out."""
    recs = sorted(recs, key=lambda r: r.num_reg_images(), reverse=True)
    kept, pending = [recs[0]], recs[1:]
    P0 = np.array([p.xyz for p in recs[0].points3D.values()])
    spread = float(np.percentile(np.linalg.norm(P0 - np.median(P0, 0), axis=1), 90)) or 1.0
    while pending:
        for r in pending:
            A, B = _shared_points(r, kept)
            if len(A) < 30:
                continue
            keep = np.ones(len(A), bool)
            for _ in range(3):                   # drop mismatched points and fit again
                sc, R, t = _sim3(A[keep], B[keep])
                res = np.linalg.norm(sc * A @ R.T + t - B, axis=1)
                keep = res < max(3 * np.median(res), 1e-3 * spread)
            if keep.sum() < 20 or np.median(res[keep]) > 0.01 * spread:
                continue
            r.transform(pycolmap.Sim3d(sc, pycolmap.Rotation3d(R), t))
            kept.append(r)
            pending.remove(r)
            break
        else:
            break
    if pending:
        log(f"{sum(r.num_reg_images() for r in pending)} photos couldn't be linked to the rest and were left out.")
    return kept


def _pose(img):
    cfw = img.cam_from_world() if callable(img.cam_from_world) else img.cam_from_world
    return cfw.rotation.matrix(), np.asarray(cfw.translation)


def _gather(recs):
    """Cameras and points from all linked groups, in one frame. A photo in several groups is counted once."""
    imgs, P, obs_p, obs_c, names = [], [], [], [], {}
    for rec in recs:
        idx = {}
        for i in sorted(rec.reg_image_ids()):
            im = rec.images[i]
            if im.name not in names:
                names[im.name] = len(imgs)
                imgs.append(im)
            idx[i] = names[im.name]
        for pt in rec.points3D.values():
            if pt.track.length() < 3 or pt.error > 2.0:
                continue
            k = len(P)
            P.append(pt.xyz)
            for el in pt.track.elements:
                if el.image_id in idx:
                    obs_p.append(k)
                    obs_c.append(idx[el.image_id])
    poses = [_pose(im) for im in imgs]
    C = np.array([-R.T @ t for R, t in poses])
    if len(P) < 200:
        raise ReconError("Too few 3D points were found. The room may be too plain, or the photos too blurry.")
    return imgs, poses, C, np.array(P), np.array(obs_p), np.array(obs_c)


# ---------------------------------------------------------------- 2–3. up, floor and ceiling

def _layers(h, unit, min_pts):
    """Heights where points pile up in a thin flat layer (floor, desk tops, ceiling), lowest first.
    Walls put points at every height, so a layer has to stand out from the heights just around it."""
    w = unit / 150                                # about 1–2 cm
    edges = np.arange(h.min() - 3 * w, h.max() + 3 * w, w)
    if len(edges) < 40:
        return []
    cnt, _ = np.histogram(h, edges)
    near = np.convolve(cnt, np.ones(3), "same")                       # within ±1.5 bins
    ring = (np.convolve(cnt, np.ones(21), "same") - np.convolve(cnt, np.ones(7), "same")) / 14 * 3
    out = []
    for i in range(1, len(cnt) - 1):
        if near[i] >= min_pts and near[i] >= near[i - 1] and near[i] > near[i + 1] and near[i] >= 2.5 * max(ring[i], 1):
            out.append(float(edges[i] + w / 2))
    return out


def up_floor_ceiling(poses, C, P):
    """Up (unit vector), the floor and ceiling heights relative to the camera centroid (SfM units),
    and a rough room size d in the same units."""
    # A phone's left-right axis stays level however it's tilted up or down, so "up" is the direction
    # at right angles to all of them. The average "down" of the photos only decides which way is up.
    right = np.array([R.T @ np.array([1.0, 0.0, 0.0]) for R, _ in poses])
    down = np.mean([R.T @ np.array([0.0, 1.0, 0.0]) for R, _ in poses], axis=0)
    _, sv, vt = np.linalg.svd(right)
    up = vt[-1] if sv[1] > 0.3 * sv[0] else -down       # needs photos facing several directions
    up = up / np.linalg.norm(up)
    if up @ down > 0:
        up = -up
    c0 = C.mean(0)
    flat = (P - c0) - np.outer((P - c0) @ up, up)
    d = float(np.median(np.linalg.norm(flat, axis=1)))
    h, cam_h = (P - c0) @ up, (C - c0) @ up
    min_pts = max(15, int(0.002 * len(P)))
    below = [x for x in _layers(h, d, min_pts) if x < cam_h.min() - 0.1 * d]
    above = [x for x in _layers(h, d, min_pts) if x > cam_h.max() + 0.1 * d]
    return up, c0, (below[0] if below else None), (above[-1] if above else None), d


# ---------------------------------------------------------------- 4. scale from the door marker

def qr_modules(text: str) -> int:
    n = len(text.encode("utf-8"))
    for v, cap in enumerate(QR_M_BYTES, start=1):
        if n <= cap:
            return 17 + 4 * v
    raise ValueError("marker text too long")


def _triangulate(views):
    """views: [(R, t, xy_normalised)] -> 3D point by linear least squares."""
    A = []
    for R, t, (x, y) in views:
        Pm = np.hstack([R, t[:, None]])
        A.append(x * Pm[2] - Pm[0])
        A.append(y * Pm[2] - Pm[1])
    X = np.linalg.svd(np.array(A))[2][-1]
    return X[:3] / X[3]


def find_marker(imgs, poses, image_dir: Path, want: str | None, log=print):
    """Find the door marker in the photos and triangulate its corners. Returns dict or None."""
    det = cv2.QRCodeDetector()
    seen = defaultdict(list)                     # text -> [(image index, 4x2 corners)]
    for k, im in enumerate(imgs):
        g = cv2.imread(str(image_dir / im.name), cv2.IMREAD_GRAYSCALE)
        if g is None:
            continue
        try:
            text, pts, _ = det.detectAndDecode(g)
        except cv2.error:
            continue
        if not text or not text.startswith("APU|") or pts is None:
            continue
        pts = pts.reshape(4, 2).astype(np.float32)
        side = np.linalg.norm(pts[0] - pts[1])
        if side < 25:                            # too small to measure from
            continue
        win = max(2, min(6, int(side / 25)))
        pts = cv2.cornerSubPix(g, pts.reshape(-1, 1, 2), (win, win), (-1, -1),
                               (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.01)).reshape(4, 2)
        seen[text].append((k, pts))
    if not seen:
        return None
    text = want if want in seen else max(seen, key=lambda t: len(seen[t]))
    obs = seen[text]
    if len(obs) < 2:
        log(f"Door marker {text} is in only one photo, so it can't be used for scale.")
        return {"text": text, "views": 1}
    corners = []
    for j in range(4):
        views = []
        for k, pts in obs:
            cam = imgs[k].camera
            xy = np.asarray(cam.cam_from_img(pts[j:j + 1].astype(np.float64))).reshape(-1)[:2]
            R, t = poses[k]
            views.append((R, t, xy))
        corners.append(_triangulate(views))
    X = np.array(corners)
    sides = np.linalg.norm(X - np.roll(X, -1, axis=0), axis=1)
    diag = (np.linalg.norm(X[0] - X[2]) + np.linalg.norm(X[1] - X[3])) / 2
    centres = np.array([-poses[k][0].T @ poses[k][1] for k, _ in obs])
    rays = [(X.mean(0) - c) / np.linalg.norm(X.mean(0) - c) for c in centres]
    spread = max(math.degrees(math.acos(np.clip(a @ b, -1, 1))) for a in rays for b in rays)
    square = sides.max() / max(sides.min(), 1e-9) < 1.15 and abs(diag / sides.mean() / math.sqrt(2) - 1) < 0.1
    m = qr_modules(text)
    real = MARKER_MM / 1000 * m / (m + 4)
    out = {"text": text, "views": len(obs), "spread": round(spread, 1), "square": bool(square),
           "centre": X.mean(0), "normal": np.cross(X[1] - X[0], X[3] - X[0])}
    if square and spread >= 3:
        out["scale"] = real / sides.mean()
    else:
        log(f"Door marker {text} found in {len(obs)} photos but its corners don't line up well enough to measure from.")
    return out


# ---------------------------------------------------------------- 5. walls

def _manhattan_angle(xy):
    def score(a):
        c, s = math.cos(a), math.sin(a)
        u, v = xy[:, 0] * c + xy[:, 1] * s, -xy[:, 0] * s + xy[:, 1] * c
        hu = np.bincount(((u - u.min()) / 0.04).astype(int))
        hv = np.bincount(((v - v.min()) / 0.04).astype(int))
        return float((hu.astype(float) ** 2).sum() + (hv.astype(float) ** 2).sum())
    best = max(np.radians(np.arange(0, 90, 0.5)), key=score)
    return max(best + np.radians(np.arange(-0.5, 0.5, 0.05)), key=score)


def _rot(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, s], [-s, c]])


def carve(cams, pts, obs_p, obs_c, keep):
    """Count, per 5 cm cell, how many camera-to-point sight lines pass through it."""
    lo = np.minimum(cams.min(0), np.percentile(pts, 1, axis=0)) - 0.5
    hi = np.maximum(cams.max(0), np.percentile(pts, 99, axis=0)) + 0.5
    shape = (int((hi[1] - lo[1]) / GRID) + 1, int((hi[0] - lo[0]) / GRID) + 1)
    if shape[0] * shape[1] > 6_000_000:
        raise ReconError("The point cloud is spread too wide to be one room. Photos from several rooms may be mixed.")
    count = np.zeros(shape, np.int32)
    sel = keep[obs_p]
    a, b = cams[obs_c[sel]], pts[obs_p[sel]]
    for i in range(0, len(a), 4000):
        aa, bb = a[i:i + 4000], b[i:i + 4000]
        L = np.linalg.norm(bb - aa, axis=1)
        n = np.maximum(1, ((L - 0.12) / (GRID * 0.6)).astype(int))
        rep = np.repeat(np.arange(len(aa)), n)
        t = (np.arange(n.sum()) - np.repeat(np.cumsum(n) - n, n)) / np.repeat(n, n) * np.repeat(np.maximum(L - 0.12, 0) / np.maximum(L, 1e-9), n)
        q = aa[rep] + (bb[rep] - aa[rep]) * t[:, None]
        ix = ((q - lo) / GRID).astype(int)
        ok = (ix[:, 0] >= 0) & (ix[:, 1] >= 0) & (ix[:, 0] < shape[1]) & (ix[:, 1] < shape[0])
        np.add.at(count, (ix[ok, 1], ix[ok, 0]), 1)
    return count, lo


def free_region(count, lo, cams):
    free = (count >= 2).astype(np.uint8)
    for c in ((cams - lo) / GRID).astype(int):
        cv2.circle(free, (int(c[0]), int(c[1])), 3, 1, -1)
    free = cv2.morphologyEx(free, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    cs, _ = cv2.findContours(free, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    filled = np.zeros_like(free)
    cv2.drawContours(filled, cs, -1, 1, -1)
    k = int(round(1.0 / GRID))                   # squares survive; doorways and windows narrower than 1 m are cut
    opened = cv2.morphologyEx(filled, cv2.MORPH_OPEN, np.ones((k, k), np.uint8))
    n, lab = cv2.connectedComponents(opened)
    if n < 2:
        raise ReconError("Couldn't find the room's free floor space from the photos.")
    ci = ((cams - lo) / GRID).astype(int)
    votes = np.bincount(lab[np.clip(ci[:, 1], 0, lab.shape[0] - 1), np.clip(ci[:, 0], 0, lab.shape[1] - 1)], minlength=n)
    votes[0] = 0
    if votes.max() == 0:
        votes = np.bincount(lab.ravel(), minlength=n)
        votes[0] = 0
    return (lab == votes.argmax()).astype(np.uint8)


def _merge(E):
    """Join neighbouring edges that run the same way."""
    changed = True
    while changed and len(E) > 1:
        changed = False
        for i in range(len(E)):
            j = (i + 1) % len(E)
            if i != j and E[i][0] == E[j][0]:
                L = E[i][2] + E[j][2]
                E[i] = [E[i][0], (E[i][1] * E[i][2] + E[j][1] * E[j][2]) / max(L, 1e-9), L]
                del E[j]
                changed = True
                break
    return E


def tidy(E, min_edge=0.3):
    """Remove steps shorter than min_edge. Returns None if no proper outline is left."""
    E = _merge([list(e) for e in E])
    while len(E) > 4:
        V = corners(E)
        lens = [float(np.hypot(*(V[i] - V[i - 1]))) for i in range(len(E))]
        for e, L in zip(E, lens):
            e[2] = L
        i = int(np.argmin(lens))
        if lens[i] >= min_edge:
            break
        del E[i]
        E = _merge(E)
    return E if len(E) >= 4 and len(E) % 2 == 0 else None


def rectilinear(V, min_edge=0.3):
    """Square up a polygon whose edges should run along the axes. V: (n, 2) metres.
    Returns edges [horizontal?, position, length], or None."""
    E = []
    for i in range(len(V)):
        a, b = V[i], V[(i + 1) % len(V)]
        d = b - a
        L = float(np.hypot(*d))
        if L < 1e-6:
            continue
        horiz = abs(d[0]) >= abs(d[1])
        E.append([horiz, (a[1] + b[1]) / 2 if horiz else (a[0] + b[0]) / 2, L])
    return tidy(E, min_edge)


def corners(E):
    out = []
    for i in range(len(E)):
        a, b = E[i], E[(i + 1) % len(E)]
        out.append([b[1], a[1]] if a[0] else [a[1], b[1]])
    return np.array(out)


def snap_walls(E, pts):
    """Move each wall to the densest layer of points near it."""
    V = corners(E)
    for i in range(len(E)):
        horiz, c, _ = E[i]
        a, b = V[i - 1], V[i]                    # corners at the two ends of edge i
        lo, hi = sorted([a[0], b[0]] if horiz else [a[1], b[1]])
        if hi - lo < 0.5:
            continue
        along, across = (pts[:, 0], pts[:, 1]) if horiz else (pts[:, 1], pts[:, 0])
        m = (along > lo + 0.2) & (along < hi - 0.2) & (np.abs(across - c) < 0.4)
        if m.sum() < 15:
            continue
        x = across[m]
        cnt, edges = np.histogram(x, np.arange(c - 0.4, c + 0.41, 0.01))
        sm = np.convolve(cnt, np.ones(5), "same")
        j = int(np.argmax(sm))
        peak = (edges[j] + edges[j + 1]) / 2
        near = x[np.abs(x - peak) < 0.03]
        if len(near) >= max(15, 0.25 * m.sum()):
            E[i][1] = float(near.mean())
    return E


# ---------------------------------------------------------------- 6. place over the drawn room

def area(poly):
    p = np.asarray(poly)
    return float(abs(np.dot(p[:, 0], np.roll(p[:, 1], -1)) - np.dot(p[:, 1], np.roll(p[:, 0], -1))) / 2)


def _iou(A, B, res=0.02):
    lo = np.minimum(A.min(0), B.min(0)) - 0.1
    hi = np.maximum(A.max(0), B.max(0)) + 0.1
    shape = (int((hi[1] - lo[1]) / res) + 1, int((hi[0] - lo[0]) / res) + 1)
    ma, mb = np.zeros(shape, np.uint8), np.zeros(shape, np.uint8)
    cv2.fillPoly(ma, [((A - lo) / res).astype(np.int32)], 1)
    cv2.fillPoly(mb, [((B - lo) / res).astype(np.int32)], 1)
    u = (ma | mb).sum()
    return float((ma & mb).sum() / u) if u else 0.0


def centroid(poly):
    p = np.asarray(poly, float)
    x, y = p[:, 0], p[:, 1]
    xn, yn = np.roll(x, -1), np.roll(y, -1)
    c = x * yn - xn * y
    a = c.sum() / 2
    if abs(a) < 1e-12:
        return p.mean(0)
    return np.array([((x + xn) * c).sum(), ((y + yn) * c).sum()]) / (6 * a)


def _edge_angle(poly):
    p = np.asarray(poly, float)
    d = np.roll(p, -1, axis=0) - p
    L = np.hypot(d[:, 0], d[:, 1])
    a = np.arctan2(d[:, 1], d[:, 0]) * 4
    return math.atan2((L * np.sin(a)).sum(), (L * np.cos(a)).sum()) / 4


def door_centres(room):
    p = room["poly"]
    out = []
    for d in room.get("doors", []):
        a, b = np.array(p[d["e"]]), np.array(p[(d["e"] + 1) % len(p)])
        out.append(a + (b - a) * d["t"])
    return np.array(out) if out else np.zeros((0, 2))


def place(poly, room, extra):
    """Rotate and move the measured outline (room frame) onto the drawn room. Returns transform fn and info."""
    D = np.array(room["poly"], float)
    phi = _edge_angle(D)
    dc = centroid(D)
    doors = door_centres(room)
    best = None
    for k in range(4):
        a = phi + k * math.pi / 2
        R = np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])
        S0 = poly @ R.T
        t = dc - centroid(S0)
        S = S0 + t
        score = _iou(S, D)
        if extra.get("marker") is not None and len(doors):
            mk = extra["marker"] @ R.T + t
            score -= 0.15 * min(2.0, float(np.min(np.linalg.norm(doors - mk, axis=1))))
        if best is None or score > best[0]:
            best = (score, R, t)
    _, R, t = best
    return (lambda X: np.asarray(X) @ R.T + t), _iou(poly @ R.T + t, D)


# ---------------------------------------------------------------- all together

def measure(recs, image_dir: Path, *, room=None, marker_text=None, work: Path | None = None, log=print):
    imgs, poses, C, P, obs_p, obs_c = _gather(recs)
    notes = []
    up, c0, floor, ceil, d = up_floor_ceiling(poses, C, P)
    floor_found = floor is not None
    if not floor_found:
        notes.append("The floor wasn't visible enough to find, so the ceiling height isn't measured. "
                     "Take a few photos tilted down at the floor.")
        floor = float(np.percentile((P - c0) @ up, 1))   # the lowest points: close to the floor, good enough for the wall band
    cam_h = float(np.median((C - c0) @ up)) - floor

    mk = find_marker(imgs, poses, image_dir, marker_text, log=log)
    if mk and "scale" in mk:
        s = mk["scale"]
        cam_metric = cam_h * s
        conf = "high" if mk["views"] >= 3 and mk["spread"] >= 10 else "medium"
        scale = {"source": "marker", "confidence": conf, "views": mk["views"]}
        if floor_found and not 0.9 <= cam_metric <= 2.0:
            notes.append(f"With the marker's scale, photos were taken {cam_metric:.2f} m above the floor, which is unusual. "
                         "Check the marker was printed at 100% size.")
            scale["confidence"] = "low"
    else:
        s = PHONE_HEIGHT / cam_h
        scale = {"source": "phone_height", "confidence": "low", "views": mk["views"] if mk else 0}
        notes.append("No door marker could be measured, so sizes assume the phone was held 1.45 m above the floor "
                     f"({'often 5–10% off' if floor_found else 'rough, as the floor was hard to see too'}). "
                     "Take 2–3 close photos of the door marker from different angles.")

    e1 = np.cross(up, [1.0, 0, 0])
    if np.linalg.norm(e1) < 0.1:
        e1 = np.cross(up, [0, 0, 1.0])
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(e1, up)                        # (e1, e2) match the plan's x right, y down

    def to_room(X):
        X = np.asarray(X) - c0
        return np.stack([X @ e1 * s, X @ e2 * s, (X @ up - floor) * s], axis=-1)

    Pr, Cr = to_room(P), to_room(C)
    height = (ceil - floor) * s if ceil is not None and floor_found else None
    if height is not None and not 1.8 <= height <= 15:
        notes.append(f"The ceiling was measured at {height:.2f} m, which looks wrong, so it was left out.")
        height = None
    if height is None and ceil is None and floor_found:
        notes.append("The ceiling wasn't visible enough to measure the height. Take a few photos tilted up.")
    top = (height - 0.15) if height else 2.8
    band = (Pr[:, 2] > 0.9) & (Pr[:, 2] < top)
    if band.sum() < 100:
        raise ReconError("Too few points were found on the walls to trace the outline.")

    theta = _manhattan_angle(Pr[band, :2])
    Rm = _rot(theta)
    pts = Pr[:, :2] @ Rm.T
    cams = Cr[:, :2] @ Rm.T
    near = np.linalg.norm(pts - cams.mean(0), axis=1) < 15
    count, lo = carve(cams, pts, obs_p, obs_c, band & near)
    region = free_region(count, lo, cams)
    cs, _ = cv2.findContours(region, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    cnt = max(cs, key=cv2.contourArea)
    approx = cv2.approxPolyDP(cnt, 0.15 / GRID, True).reshape(-1, 2) * GRID + lo
    E = rectilinear(approx)
    if E is None:
        x, y, w, h = cv2.boundingRect(cnt)
        x0, y0 = np.array([x, y]) * GRID + lo
        E = [[True, y0, w * GRID], [False, x0 + w * GRID, h * GRID], [True, y0 + h * GRID, w * GRID], [False, x0, h * GRID]]
        notes.append("The outline couldn't be squared up, so it's shown as a rectangle.")
    wall_pts = pts[band & near]
    E = snap_walls(E, wall_pts)
    E = tidy(E) or E                             # snapping can line up two walls that were a step apart
    poly = corners(E)
    if area(poly) < 1.0:
        raise ReconError("The measured room is under 1 m², which can't be right.")

    marker_xy = None
    if mk and "centre" in mk:
        marker_xy = to_room(mk["centre"][None])[0, :2] @ Rm.T
    result = {
        "area": round(area(poly), 2),
        "height": round(float(height), 2) if height else None,
        "scale": scale,
        "images": {"placed": len(imgs)},
        "points": int(len(P)),
        "notes": notes,
    }
    if room and len(room.get("poly", [])) >= 3:
        tf, iou = place(poly, room, {"marker": marker_xy})
        result["aligned"] = True
        result["match"] = round(iou, 3)
    else:
        off = -poly.min(0)
        tf = lambda X: np.asarray(X) + off
        result["aligned"] = False
    rnd = lambda A: np.round(tf(A), 2).tolist()
    result["poly"] = rnd(poly)
    placed = np.array(result["poly"])
    result["size"] = [round(float(np.ptp(placed[:, 0])), 2), round(float(np.ptp(placed[:, 1])), 2)]   # as shown on the plan
    sub = wall_pts if len(wall_pts) <= 1500 else wall_pts[np.random.default_rng(0).choice(len(wall_pts), 1500, replace=False)]
    result["wallPoints"] = rnd(sub)
    result["cameras"] = rnd(cams)
    result["marker"] = rnd(marker_xy[None])[0] if marker_xy is not None else None

    if work is not None:
        _preview(work / "preview.png", region, lo, wall_pts, cams, poly, marker_xy)
    return result


def _preview(path, region, lo, pts, cams, poly, marker):
    s = 4                                        # pixels per grid cell
    img = np.full((region.shape[0] * s, region.shape[1] * s, 3), 255, np.uint8)
    img[cv2.resize(region, (img.shape[1], img.shape[0]), interpolation=cv2.INTER_NEAREST) > 0] = (235, 225, 210)
    px = lambda X: (((np.asarray(X) - lo) / GRID) * s).astype(np.int32)
    for p in px(pts):
        cv2.circle(img, tuple(int(v) for v in p), 1, (60, 60, 60), -1)
    for p in px(cams):
        cv2.circle(img, tuple(int(v) for v in p), 4, (200, 120, 30), -1)
    cv2.polylines(img, [px(poly)], True, (40, 40, 220), 2)
    if marker is not None:
        cv2.circle(img, tuple(int(v) for v in px(marker[None])[0]), 7, (40, 170, 40), -1)
    cv2.imwrite(str(path), img)


def prepare_images(files: list[tuple[str, bytes]], image_dir: Path):
    """Write photos into one folder per image size, so each size gets its own COLMAP camera."""
    for name, data in files:
        im = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_UNCHANGED)
        if im is None:
            continue
        sub = image_dir / f"{im.shape[1]}x{im.shape[0]}"
        sub.mkdir(parents=True, exist_ok=True)
        (sub / os.path.basename(name)).write_bytes(data)
