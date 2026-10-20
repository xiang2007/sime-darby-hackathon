"""Map a floor from one walk-through video: the hallways, the rooms off them, and the doors between them.

Film one walk that goes along the hallway and steps into each room. Because every frame is placed in one 3D
model, the rooms and hallways come out where they really are relative to each other, and each door sits where
the walk went through it.

Steps:
  1. COLMAP places every frame (floorplan.run_sfm), and walk.walk_frame finds up, the floor and the scale, and
     squares everything up to the building, as for --walk.
  2. The floor space: the space each frame could see through is carved out on a 5 cm grid (floorplan.carve).
  3. Doorways are where that space narrows to under 1.1 m. Each wider part (a room, a hallway) is grown out
     from its middle until it meets its neighbours, so the parts meet in the doorways.
  4. Each part's outline is squared up and snapped to its walls. Walls that face each other across a thin gap
     are moved onto one line, so neighbouring rooms share their walls the way they're drawn on the plan.
  5. A door goes in each doorway, on the room's wall. Long, narrow parts are corridors, big branching open ones
     lobbies (the same rule as the app's "Mark as hallways").
  6. Door signs ("B-04-02") and door QR markers name the room behind the door they're next to.

All lengths are in metres, in floor-plan coordinates (x right, y down on screen).
"""
from __future__ import annotations

import heapq
from collections import Counter, defaultdict
from pathlib import Path

import cv2
import numpy as np

from floorplan import GRID, ReconError, area, carve, corners, rectilinear, snap_walls, tidy
from walk import SignReader, _outward, walk_frame

NECK = 0.55        # half the widest doorway: passages narrower than 1.1 m are doorways
OPEN = 1.0         # outlines drop stubs narrower than this, such as the doorway itself
MIN_AREA = 2.0     # m², smaller parts are left out
MAX_GAP = 0.6      # walls this close, facing each other, are one wall seen from both sides
WALL_BAND = (0.3, 1.9)   # m above the floor: wall points here block the floor space (below door heads)
DOOR_GAP = 0.3     # the app joins a door to a room with a wall this close (DOOR_GAP in web/index.html)
HALL = {"max_width": 3.5, "min_ratio": 3.0, "lobby_area": 60.0, "lobby_fill": 0.6, "lobby_width": 6.0}   # HALL in web/index.html
CIRCULATION = ("corridor", "lobby")


# ---------------------------------------------------------------- floor space and doorways

def wall_cells(pts, heights, shape, lo):
    """Cells with wall points between knee and head height: below a door's head, so doorways stay open.
    Thin walls between a room and the hallway are solid here even where the floor space either side nearly meets."""
    sel = (heights > WALL_BAND[0]) & (heights < WALL_BAND[1])
    ix = np.round((pts[sel] - lo) / GRID).astype(int)
    ok = (ix[:, 0] >= 0) & (ix[:, 1] >= 0) & (ix[:, 0] < shape[1]) & (ix[:, 1] < shape[0])
    n = np.zeros(shape, np.int32)
    np.add.at(n, (ix[ok, 1], ix[ok, 0]), 1)
    return cv2.dilate((n >= 2).astype(np.uint8), np.ones((3, 3), np.uint8))


def free_space(count, cams, lo, walls=None):
    """Cells the frames saw through (at least twice), plus where the camera was, less the walls, with small
    holes filled. Only the part the walk went through is kept."""
    free = (count >= 2).astype(np.uint8)
    ci = np.round((cams - lo) / GRID).astype(int)
    for c in ci:
        cv2.circle(free, (int(c[0]), int(c[1])), int(round(0.3 / GRID)), 1, -1)
    free = cv2.morphologyEx(free, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    if walls is not None:                        # after closing, which would bridge a thin wall
        free[walls > 0] = 0
    cs, hier = cv2.findContours(free, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if hier is not None:
        for c, h in zip(cs, hier[0]):
            if h[3] >= 0 and cv2.contourArea(c) * GRID ** 2 < 4.0:     # a pillar or a desk, not a block of rooms
                cv2.drawContours(free, [c], -1, 1, -1)
    n, lab = cv2.connectedComponents(free, connectivity=4)
    ci = np.clip(ci, 0, [free.shape[1] - 1, free.shape[0] - 1])
    votes = np.bincount(lab[ci[:, 1], ci[:, 0]], minlength=n)
    votes[0] = 0
    if votes.max() == 0:
        raise ReconError("Couldn't find the floor space the walk went through.")
    return (lab == votes.argmax()).astype(np.uint8)


def split(free, neck=NECK, min_area=1.0):
    """Split the floor space at doorways. Returns a label image (-1 outside, 1..n parts).
    The middle of each wide part (further than `neck` from any wall) seeds it; parts then grow outwards, cells
    furthest from the walls first, so two parts meet where the space is narrowest: in the doorway."""
    D = cv2.distanceTransform(free, cv2.DIST_L2, 5) * GRID
    n, core = cv2.connectedComponents((D >= neck).astype(np.uint8), connectivity=4)
    lab = np.where(free > 0, 0, -1).astype(np.int32)
    sizes = np.bincount(core.ravel(), minlength=n)
    k = 0
    for i in range(1, n):
        if sizes[i] * GRID ** 2 >= min_area:
            k += 1
            lab[core == i] = k
    if k == 0:                                   # nothing wider than a doorway: one part
        lab[free > 0] = 1
        return lab
    H, W = lab.shape
    heap = []
    ys, xs = np.nonzero(lab > 0)
    for y, x in zip(ys, xs):
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            yy, xx = y + dy, x + dx
            if 0 <= yy < H and 0 <= xx < W and lab[yy, xx] == 0:
                heapq.heappush(heap, (-D[yy, xx], yy, xx, lab[y, x]))
    while heap:
        _, y, x, l = heapq.heappop(heap)
        if lab[y, x] != 0:
            continue
        lab[y, x] = l
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            yy, xx = y + dy, x + dx
            if 0 <= yy < H and 0 <= xx < W and lab[yy, xx] == 0:
                heapq.heappush(heap, (-D[yy, xx], yy, xx, l))
    return lab


def doorways(lab, lo):
    """Where two parts touch: [{a, b, c (centre), horiz (the wall runs along x), w (width)}]."""
    cells = defaultdict(list)
    for dy, dx in ((0, 1), (1, 0)):
        A = lab[:lab.shape[0] - dy, :lab.shape[1] - dx]
        B = lab[dy:, dx:]
        m = (A > 0) & (B > 0) & (A != B)
        for y, x in zip(*np.nonzero(m)):
            a, b = int(A[y, x]), int(B[y, x])
            key = (min(a, b), max(a, b))
            cells[key].append((y, x))
            cells[key].append((y + dy, x + dx))
    out = []
    for (a, b), cs in cells.items():
        cs = np.array(sorted(set(cs)))
        mask = np.zeros(lab.shape, np.uint8)
        mask[cs[:, 0], cs[:, 1]] = 1
        n, cl = cv2.connectedComponents(mask, connectivity=8)
        for i in range(1, n):
            ys, xs = np.nonzero(cl == i)
            if len(ys) < 4:
                continue
            ex, ey = (xs.max() - xs.min() + 1) * GRID, (ys.max() - ys.min() + 1) * GRID
            c = lo + (np.array([xs.mean(), ys.mean()]) + 0.5) * GRID
            out.append({"a": a, "b": b, "c": c, "horiz": bool(ex >= ey), "w": float(max(ex, ey))})
    return out


# ---------------------------------------------------------------- outlines

def outline(mask, lo, wall_pts):
    """A part's outline: doorway stubs cut off, squared up, each wall snapped to the points found on it."""
    k = int(round(OPEN / GRID))
    m = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((k, k), np.uint8))
    n, cl, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=4)
    if n < 2:
        return None
    m = (cl == 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))).astype(np.uint8)
    if m.sum() * GRID ** 2 < MIN_AREA:
        return None
    cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    cnt = max(cs, key=cv2.contourArea)
    approx = cv2.approxPolyDP(cnt, 0.15 / GRID, True).reshape(-1, 2) * GRID + lo
    E = rectilinear(approx)
    if E is None:
        x, y, w, h = cv2.boundingRect(cnt)
        x0, y0 = np.array([x, y]) * GRID + lo
        E = [[True, y0, w * GRID], [False, x0 + w * GRID, h * GRID], [True, y0 + h * GRID, w * GRID], [False, x0, h * GRID]]
    E = snap_walls(E, wall_pts)
    E = tidy(E) or E
    return corners(E)


def _edges(V):
    """[(i, horiz, position, lo, hi)] for each edge of a squared-up outline."""
    out = []
    for i in range(len(V)):
        a, b = V[i], V[(i + 1) % len(V)]
        horiz = abs(b[1] - a[1]) < abs(b[0] - a[0])
        lo, hi = sorted([a[0], b[0]] if horiz else [a[1], b[1]])
        out.append((i, horiz, float((a[1] + b[1]) / 2 if horiz else (a[0] + b[0]) / 2), float(lo), float(hi)))
    return out


def _set_edge(V, i, horiz, pos):
    j = (i + 1) % len(V)
    ax = 1 if horiz else 0
    V[i][ax] = V[j][ax] = pos


def align_walls(polys, max_gap=MAX_GAP, min_overlap=0.3):
    """Walls of two parts that face each other across a gap under max_gap are one wall seen from both sides:
    put them on one line (the middle of the gap). Longest shared walls go first; a wall already moved stays put
    and the other side comes to it. polys: {key: (n, 2) array}, changed in place."""
    pairs = []
    keys = list(polys)
    for ia, ka in enumerate(keys):
        for kb in keys[ia + 1:]:
            A, B = polys[ka], polys[kb]
            for i, h, p, lo, hi in _edges(A):
                na = _outward(A, i)
                for j, h2, q, lo2, hi2 in _edges(B):
                    if h != h2 or abs(q - p) > max_gap:
                        continue
                    ov = min(hi, hi2) - max(lo, lo2)
                    if ov < min_overlap:
                        continue
                    ax = 1 if h else 0
                    nb = _outward(B, j)
                    if (q - p) * na[ax] < -0.05 or (p - q) * nb[ax] < -0.05:     # not facing each other
                        continue
                    pairs.append((ov, ka, i, kb, j, h))
    fixed = set()
    for ov, ka, i, kb, j, h in sorted(pairs, key=lambda x: -x[0]):
        A, B = polys[ka], polys[kb]
        p = dict((e[0], e[2]) for e in _edges(A))[i]
        q = dict((e[0], e[2]) for e in _edges(B))[j]
        fa, fb = (ka, i) in fixed, (kb, j) in fixed
        if fa and fb:
            continue
        to = (p + q) / 2 if not (fa or fb) else (p if fa else q)
        _set_edge(A, i, h, to)
        _set_edge(B, j, h, to)
        fixed |= {(ka, i), (kb, j)}


def shape_of(poly):
    """Width (twice the distance from the middle of the shape to its walls), length (area / width), how much of
    its bounding box it fills, and what kind of space that suggests. Same rule as shapeOf in web/index.html."""
    p = np.asarray(poly, float)
    lo = p.min(0) - 2 * GRID
    size = np.ceil((p.max(0) - lo) / GRID).astype(int) + 3
    m = np.zeros((size[1], size[0]), np.uint8)
    cv2.fillPoly(m, [np.round((p - lo) / GRID).astype(np.int32)], 1)
    D = cv2.distanceTransform(m, cv2.DIST_L2, 5) * GRID
    ridge = D[(D >= cv2.dilate(D, np.ones((3, 3), np.uint8)) - 1e-6) & (D >= 2 * GRID)]
    A = area(p)
    width = 2 * float(np.median(ridge)) if len(ridge) else float(min(np.ptp(p, 0)))
    length = A / max(width, 0.1)
    fill = A / max(float(np.prod(np.ptp(p, 0))), 1e-9)
    if width <= HALL["max_width"] and length >= HALL["min_ratio"] * width:
        kind = "corridor"
    elif A >= HALL["lobby_area"] and fill < HALL["lobby_fill"] and width <= HALL["lobby_width"]:
        kind = "lobby"
    else:
        kind = "room"
    return {"width": width, "length": length, "fill": fill, "kind": kind}


# ---------------------------------------------------------------- doors

def _seg_dist(c, a, b):
    d = b - a
    t = float(np.clip((c - a) @ d / max(d @ d, 1e-12), 0, 1))
    return float(np.hypot(*(c - (a + d * t)))), t


def door_on(V, c, horiz, w):
    """The edge of outline V running the way the doorway's wall does, nearest to its centre c:
    (edge, t, width, distance), with the door kept inside the edge."""
    best = None
    for i, h, *_ in _edges(V):
        if h != horiz:
            continue
        a, b = V[i], V[(i + 1) % len(V)]
        d, t = _seg_dist(c, a, b)
        if best is None or d < best[3]:
            L = float(np.hypot(*(b - a)))
            ww = min(w, 0.9 * L)
            half = ww / 2 / max(L, 1e-9)
            best = (i, float(np.clip(t, half, 1 - half)), ww, d)
    return best


def place_doors(regions, ways, notes):
    """One door per doorway, on the wall of the room (or, between two hallways or two rooms, the smaller one)."""
    by = {r["label"]: r for r in regions}
    for dw in ways:
        a, b = by.get(dw["a"]), by.get(dw["b"])
        if a is None or b is None:
            continue
        hosts = sorted([a, b], key=lambda r: (r["type"] in CIRCULATION, r["area"]))
        w = float(np.clip(dw["w"], 0.7, 2.0))
        for host in hosts:
            other = b if host is a else a
            got = door_on(host["poly"], dw["c"], dw["horiz"], w)
            if got is None or got[3] > 1.0:
                continue
            e, t, ww, _ = got
            pa, pb = host["poly"][e], host["poly"][(e + 1) % len(host["poly"])]
            at = pa + (pb - pa) * t
            gap = min(_seg_dist(at, other["poly"][k], other["poly"][(k + 1) % len(other["poly"])])[0] for k in range(len(other["poly"])))
            host["doors"].append({"e": int(e), "t": round(t, 4), "w": round(ww, 2), "to": other["label"], "at": at, "gap": gap})
            break
        else:
            notes.append("A doorway couldn't be matched to a wall, so it has no door. Add it on the Floor plan.")


# ---------------------------------------------------------------- all together

def map_floor(recs, image_dir: Path, *, times=None, ocr=True, floor_level=None, block=None, work: Path | None = None, log=print):
    """recs: from floorplan.run_sfm, frames in walking order. times: {image basename: seconds into the video}."""
    F = walk_frame(recs, times)
    imgs, poses, flat, Rm, pts, cams, wall_pts, notes = (F[k] for k in
        ("imgs", "poses", "flat", "Rm", "pts", "cams", "wall_pts", "notes"))
    k = 2
    sm = np.array([np.median(cams[max(0, i - k):i + k + 1], axis=0) for i in range(len(cams))])
    length = float(np.hypot(*np.diff(sm, axis=0).T).sum())
    if length < 3:
        raise ReconError(f"The walk is only {length:.1f} m long. Walk along the hallway and into each room.")

    log("Carving out the floor space…")
    # every point counts for seeing through, the floor in front of the camera too, so the middle of a room
    # walked round is filled in
    count, lo = carve(cams, pts, F["obs_p"], F["obs_c"], F["heights"] > -0.3)
    free = free_space(count, cams, lo, wall_cells(pts, F["heights"], count.shape, lo))
    lab = split(free)
    ways = doorways(lab, lo)
    log(f"Found {lab.max()} rooms and hallways, {len(ways)} doorway(s).")

    ci = np.clip(np.round((cams - lo) / GRID).astype(int), 0, [lab.shape[1] - 1, lab.shape[0] - 1])
    cam_lab = lab[ci[:, 1], ci[:, 0]]
    regions = []
    for l in range(1, lab.max() + 1):
        poly = outline((lab == l).astype(np.uint8), lo, wall_pts)
        if poly is None:
            continue
        regions.append({"label": l, "poly": np.asarray(poly, float), "doors": [], "visited": int((cam_lab == l).sum())})
    if not regions:
        raise ReconError("No rooms or hallways could be traced from the walk.")
    align_walls({r["label"]: r["poly"] for r in regions})
    for r in regions:
        g = shape_of(r["poly"])
        r.update(area=area(r["poly"]), width=g["width"], type=g["kind"])
    if len(regions) == 1:
        regions[0]["type"] = "corridor" if regions[0]["type"] == "room" else regions[0]["type"]
        notes.append("No doorways were found, so the whole walk is one space. Walk through each door into the room behind it.")
    place_doors(regions, ways, notes)

    # door signs: the sign beside a door names the room on the far side of that door
    reader = SignReader(ocr=ocr, log=log)
    votes, seen, blocks, floors = defaultdict(Counter), Counter(), Counter(), Counter()
    doors = [(r["label"], d) for r in regions for d in r["doors"]]
    log(f"Reading door signs in {len(imgs)} frames…")
    for i, im in enumerate(imgs):
        reads = reader.read(image_dir / im.name)
        if not reads:
            continue
        here = int(cam_lab[i])
        for code, blk, fl, (u, v), src in reads:
            seen[(code, src)] += 1
            blocks[blk] += 1
            floors[fl] += 1
            xy = np.asarray(im.camera.cam_from_img(np.array([[u, v]], float))).reshape(-1)[:2]
            R, _ = poses[i]
            d = flat((R.T @ np.array([xy[0], xy[1], 1.0]))[None])[0] @ Rm.T
            if np.hypot(*d) < 0.2 or here <= 0:
                continue
            d /= np.hypot(*d)
            hit = _march(lab, lo, cams[i], d)
            if hit is None:
                continue
            near = [(float(np.hypot(*(dd["at"] - hit))), host, dd["to"]) for host, dd in doors if here in (host, dd["to"])]
            near = [x for x in near if x[0] < 2.0]
            if near:
                _, host, to = min(near)
                votes[code][to if host == here else host] += 1
    names, taken = {}, set()
    for code, l, n in sorted(((c, l, n) for c, cnt in votes.items() for l, n in cnt.items()), key=lambda x: -x[2]):
        if code not in names.values() and l not in taken:
            names[l] = code
            taken.add(l)
    floor_level = floor_level if floor_level is not None else (floors.most_common(1)[0][0] if floors else None)
    block = block or (blocks.most_common(1)[0][0] if blocks else None)
    if floor_level is None:
        notes.append("The floor number wasn't given or read from a sign; choose it when you import the map.")
    codes = sorted({c for c, _ in seen})
    if codes:
        log("Signs read: " + ", ".join(f"{c} ({sum(n for (cc, _), n in seen.items() if cc == c)}×)" for c in codes))
    unplaced = [c for c in codes if c not in names.values()]
    if unplaced:
        notes.append(f"{', '.join(unplaced)} {'was' if len(unplaced) == 1 else 'were'} read but couldn't be matched to a door.")
    for r in regions:
        if not r["visited"] and r["type"] not in CIRCULATION:
            notes.append(f"{names.get(r['label'], 'A room')} was only seen through its door, so its outline is partial. "
                         "Walk into it and round it.")
    far = [d for r in regions for d in r["doors"] if d["gap"] > DOOR_GAP]
    if far:
        notes.append(f"{len(far)} door(s) aren't on a wall shared with the next room, so Directions can't use them yet. "
                     "Drag the rooms together on the Floor plan.")

    # shift so everything starts at (0, 0)
    off = -np.vstack([r["poly"] for r in regions]).min(0)
    rnd = lambda A: np.round(np.asarray(A) + off, 2).tolist()
    order = sorted(regions, key=lambda r: (r["type"] not in CIRCULATION, -r["area"]))
    result = {
        "kind": "map",
        "block": block,
        "floor": floor_level,
        "length": round(length, 1),
        "regions": [{"id": names.get(r["label"]), "type": r["type"] if r["type"] in CIRCULATION else "other",
                     "poly": rnd(r["poly"]), "area": round(r["area"], 1), "width": round(r["width"], 2),
                     "doors": [{"e": d["e"], "t": d["t"], "w": d["w"]} for d in r["doors"]],
                     "partial": not r["visited"]} for r in order],
        "doors": sum(len(r["doors"]) for r in regions),
        "signs": [{"room": c, "seen": sum(n for (cc, _), n in seen.items() if cc == c),
                   "source": "marker" if (c, "marker") in seen else "sign", "placed": c in names.values()} for c in codes],
        "path": rnd(sm),
        "scale": F["scale"],
        "images": {"placed": len(imgs)},
        "points": int(len(F["P"])),
        "notes": notes,
    }
    if work is not None:
        _preview(work / "preview.png", order, names, sm, wall_pts, lo, lab)
    return result


def _march(lab, lo, c, d, step=0.025, max_s=15.0):
    """Follow the sight line from c along d until it leaves the floor space; the last point inside, or None."""
    last = None
    for s in np.arange(0.1, max_s, step):
        q = c + d * s
        x, y = np.round((q - lo) / GRID).astype(int)
        if not (0 <= y < lab.shape[0] and 0 <= x < lab.shape[1]) or lab[y, x] < 0:
            return last
        last = q
    return None


def _preview(path, regions, names, line, pts, lo, lab):
    allp = np.vstack([r["poly"] for r in regions] + [line])
    a, b = allp.min(0) - 1, allp.max(0) + 1
    s = 40                                       # pixels per metre
    img = np.full((int((b[1] - a[1]) * s) + 1, int((b[0] - a[0]) * s) + 1, 3), 255, np.uint8)
    px = lambda X: np.round((np.asarray(X) - a) * s).astype(np.int32)
    col = {"corridor": (210, 190, 150), "lobby": (200, 170, 210), "room": (170, 215, 175)}
    for r in regions:
        cv2.fillPoly(img, [px(r["poly"])], col.get(r["type"], (200, 200, 200)))
    for p in px(pts[:: max(1, len(pts) // 4000)]):
        cv2.circle(img, (int(p[0]), int(p[1])), 1, (90, 90, 90), -1)
    for r in regions:
        cv2.polylines(img, [px(r["poly"])], True, (60, 60, 60), 2)
        for d in r["doors"]:
            V = r["poly"]
            p0, p1 = V[d["e"]], V[(d["e"] + 1) % len(V)]
            u = (p1 - p0) / max(np.hypot(*(p1 - p0)), 1e-9)
            cv2.line(img, tuple(px(d["at"] - u * d["w"] / 2)), tuple(px(d["at"] + u * d["w"] / 2)), (30, 30, 220), 5)
        c = px(r["poly"].mean(0))
        cv2.putText(img, names.get(r["label"], r["type"]), (int(c[0]) - 40, int(c[1])), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (20, 20, 20), 2)
    cv2.polylines(img, [px(line)], False, (200, 120, 30), 2)
    cv2.imwrite(str(path), img)
