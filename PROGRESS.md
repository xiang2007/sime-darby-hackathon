# UCampass(PIC): progress report

Last updated: 2026-10-20 · Live on `main` (Vercel)

**Goal:** indoor directions from room A to room B, on a map that ordinary phones build from photos or video. Exact room sizes don't matter; hallways, connections and rough distances do.

---

## 1. Status

| Area | Status |
|---|---|
| Floor plan editor (rooms, doors, floors, stairs, lifts) | Working |
| Directions: room to room, across floors, step-free option, deep links | Working |
| 3D outline view; GLB, GeoJSON, JSON export | Working |
| Contribute: photo checks, Live camera auto-capture (≤80 frames) | Working |
| Photo upload to Neon Postgres (EXIF/GPS stripped) | Working, capped by the 0.5 GB free tier |
| GPS tag for sessions, "Place on map" | Working (10–50 m indoors) |
| University picker and logos | Working |
| Worker: measure one room from photos or video (COLMAP) | Rendered rooms only |
| **Worker `--walk`: trace a corridor from a walk video** | **New**, rendered corridor only |
| **App: Floor plan → Walks → Import walk** | **New**, working |
| ffmpeg bundled via `imageio-ffmpeg` (was F2) | Fixed |
| **OSM campus outline: boundary, footprints, paths on "Place on map"; snap block to footprint; 3D ground outline; GeoJSON export** | **New**, working with a real APU snapshot |

### How `--walk` works (`worker/walk.py`)
- **Path and scale:** COLMAP with sequential matching gives the camera path. "Up" comes from the walk's plane. Scale comes from phone height (1.45 m), checked against walking pace (1.25 m/s).
- **Shape:** the path is squared to the building's main directions and split into straight runs. Each run's two walls come from 3D points, so width is measured, not assumed. Runs extend to end walls when those were filmed.
- **Doors:** RapidOCR (CPU) reads signs like `B-03-02` (QR markers optional). Sight lines from several frames are crossed to place each sign. One-off misreads next to a real sign are dropped.
- **Rooms:** a placeholder room (≤4 × 4 m) goes behind each door, sized so rooms don't overlap.
- **Output:** `walk.json` and `preview.png`. Floor and block come from the signs, or `--floor` / `--block`.

### Test results (rendered L-shaped corridor, 27 s walk, 5 door signs)
| Check | Result |
|---|---|
| Frames placed | 46 / 46 |
| Area | 81–86 m² (true 85.4) |
| Width | 2.35–2.6 m (true 2.4) |
| Phone-height vs walking-pace scale | agree within 1% |
| Signs → doors | 4 / 5, each 0.1–0.5 m off; 1 misread dropped |
| Import walk → Directions (headless Chromium) | Route found, correct turns, no errors |
| Run time | 3m48s (sequential matching; 5m55s exhaustive) |
| Unit tests | `cd worker && python -m unittest test_walk`: 8 pass |

---

## 2. Open problems

| # | Problem | Impact | Fix |
|---|---|---|---|
| F1 | **Not run on a real corridor** | Glass, blank walls, people, blur and real sign styles untested | Film 2–3 APU corridors (README tips), run `--walk`, check `preview.png` |
| F5 | Scale without a marker is rough | 5–10% distance error; pace check flags big ones | Acceptable for navigation |
| F6 | No scalable media storage (80-photo cap, Neon 0.5 GB, Vercel body limit) | `--walk` is offline only | R2/S3 presigned uploads, then a "walk" session type |
| F9 | Walks aren't aligned to existing rooms; editor can't move groups | Merging into an existing plan needs redrawing | Align by shared door signs; add "move selection" |
| F10 | A sign seen only side-on was missed | Missing rooms on fast walks | Slow down at signs, or `--fps 3` |
| F11 | Walks aren't joined | Two walks of one hallway overlap | Merge at shared signs/junctions |

F4 and F8 from earlier reports are unchanged and not blocking.

---

## 3. Campus outline from OpenStreetMap (OSM): steps 1–4 done

**Why:** blocks are placed by hand ("Place on map") on plain OSM tiles, and nothing shows where the campus ends or how buildings connect outside. OSM already maps many campuses: the boundary, building footprints and footpaths. Using that data gives a clear campus perimeter, a check on block placement, and outdoor routes between blocks. It doesn't help indoors; corridors still come from walks.

**What to fetch** (one Overpass query around APU, Technology Park Malaysia, Bukit Jalil):
| OSM data | Tags | Use |
|---|---|---|
| Campus boundary | `amenity=university` (way/relation), `landuse=education` | Perimeter outline on the map and in 3D |
| Building footprints | `building=*` inside the boundary, with `name` / `ref` | Snap blocks to real outlines; label blocks |
| Footpaths and roads | `highway=footway\|path\|pedestrian\|steps\|service`, `covered=yes` | Outdoor routing between block entrances |
| Entrances | `entrance=*` nodes | Join indoor and outdoor routes |

**Steps:**
1. **Check coverage (P0, 1 h).** Open the area on openstreetmap.org or overpass-turbo.eu. If the boundary or blocks are missing, trace them in the OSM editor (ODbL licence; credit "© OpenStreetMap contributors", already shown on the map).
2. **Snapshot script (`tools/osm_campus.py`).** Run the Overpass query once and save `web/data/apu-campus.geojson` (boundary, buildings, paths, entrances). The app loads a static file, so there's no runtime dependency on Overpass and it works offline.
3. **Show the perimeter.** Draw the boundary and footprints as a Leaflet layer in "Place on map", and as a faint ground outline in the 3D view.
4. **Snap blocks.** In "Place on map", pick a footprint; the block's position and rotation are fitted to it (rotation from the footprint's longest edge, the same 4-way search as `place()` in `floorplan.py`). The fitted `geo` is saved as it is now.
5. **Outdoor routing (later).** Turn footpaths into a graph, link it to each block's ground-floor entrance doors, and let Directions route between blocks.

**Built (2026-10-20):**
- `scripts/osm-campus.mjs` saves `web/data/apu-campus.osm.json` (raw Overpass JSON). It reads the query from `web/index.html` (`CAMPUS_QUERY`), so the app and the script ask the same thing. It also takes a file exported from overpass-turbo.eu.
- The app loads that snapshot; without one it asks Overpass from the browser and caches the answer for 7 days.
- "Place on map" draws the boundary (gold dashed), buildings, footpaths (covered ones thicker) and entrances. Tap a building → **Snap to building**: rotation from the dominant wall direction of plan and footprint, 4-way search by overlap, position by area centroid. The building id is saved as `geo.osm` (validated as `way/N` or `relation/N`).
- 3D view: faint boundary and footprints on the ground (kept out of the GLB export).
- GeoJSON export: adds `campus_boundary` and the snapped `building_footprint` with OSM credit.
- Tests: `test/campus.test.mjs` (parsing, multipolygon rings, snap recovers a 30° and a −120° turn within 1°, corners within 0.5 m). Headless Chromium with a stand-in snapshot: snap found the 25° turn, 91% overlap, saved `osm: way/3`, 3D and export correct, no page errors.

**Snapshot (2026-10-20, `web/data/apu-campus.osm.json`, 330 KB):** the APU boundary is mapped (`way/944352525`, about 45,000 m²). There are 389 buildings and 267 paths in the area, 3 of them covered, and no entrance nodes. Only **one building lies inside the boundary**: APU's main building (`way/541804093`, unnamed, 10 levels, footprint about 17,200 m²). OSM doesn't split it into Blocks A, B and so on.

**So for APU, snapping only lines a block up with the building's walls.** When the plan is less than half the footprint's area, Snap to building picks the wall-aligned turn closest to the current one and leaves the position to the person. On the real data it turned Block B to 37.6°. A whole-building plan still snaps fully (position and turn). Headless Chromium on the real snapshot: boundary, footprint and paths drawn, `geo.osm` saved, 3D outline and GeoJSON export correct, no page errors.

**Open:**
- Placing a block inside the main building is by hand. Options: draw the block outlines inside the building in OSM (`building:part=*`) and snapshot again, or align by shared door signs once two blocks are placed (F9).
- No `entrance=*` nodes, so step 5 (outdoor routing) needs the main entrances added in OSM first.
- To refresh the snapshot, run `node scripts/osm-campus.mjs` on a normal internet connection. Overpass refuses requests from the cloud sandbox.

**Risks:** footprints can be a few metres off; covered walkways are often missing from OSM (only 3 covered paths in the snapshot).

---

## 4. Next steps

| Priority | Task | Why |
|---|---|---|
| P0 | F1: run `--walk` on real APU corridors; tune OCR confidence and `SIGN` regex to APU signs | Proves it outside the renderer |
| P1 | Align a walk to existing rooms by shared signs (4-way rotation search, as `place()` in `floorplan.py`) | Walks build up one plan |
| P1 | Merge overlapping corridors into one polygon | More walks → better map |
| P1 | "Walk" session in Live camera (ordered, timestamped frames) + server-mode `--walk` | No laptop step for contributors |
| P2 | F6: R2/S3 media storage | Video uploads at scale |
| P2 | Map APU's block outlines (`building:part`) and main entrances in OSM, then re-run `node scripts/osm-campus.mjs` | Full snap for blocks inside the main building; entrances for outdoor routing |
| P2 | Outdoor routing over OSM footpaths (§3 step 5) | Directions between blocks |
| P3 | MASt3R/DUSt3R for blank corridors; visual place recognition | Robustness, markerless "you are here" |

---

## 5. Quick reference

```sh
# Setup (Python 3.10–3.13); ffmpeg and OCR come with the requirements
cd worker && python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Trace a corridor, then Floor plan → Import walk
python worker.py --walk --video corridor.mp4 [--floor 3] [--block B] [--no-ocr]

# Measure one room
python worker.py --video walk.mp4 --plan plan.json --room B-03-02
python worker.py --photos session-42-B-03-02.zip --plan plan.json

# Connected to the website (room sessions)
python worker.py --server https://your-app.vercel.app --key YOUR_WORKER_KEY

# Tests
python -m unittest test_walk          # worker (in worker/)
npm test                              # API validation + campus outline

# OSM campus snapshot (needs internet), then commit web/data/apu-campus.osm.json
node scripts/osm-campus.mjs [overpass-export.json]
```
