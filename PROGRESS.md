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
| **Viewers vs editors:** visitors only see the built floor plan (no drawing tools) but can still contribute; editing needs `EDIT_KEY` | **New**, working |
| University picker and logos | Working |
| Worker: measure one room from photos or video (COLMAP) | Rendered rooms only |
| Worker `--walk`: trace a corridor from a walk video | Working on a rendered corridor; not yet on a real one (F1) |
| Floor plan → Walks → Import walk | Working |
| **Worker `--map`: map a floor's hallway, rooms and the doors between them from one walk; Import walk or map** | **New**, working on a rendered floor; not yet on a real one (F1) |
| **OSM campus snapshot** (`web/data/apu-campus.osm.json`) | **New**, real APU data, 2026-10-20 |
| **Campus outline on "Place on map"; Snap to building** | **New**, working (turn only for APU, see §3) |
| **Campus backdrop under the Floor plan and in 3D; corners snap to the building outline** | **New**, working |
| **Move tool: move and turn a walk (or any joined rooms) as one; Line up with building** | **New**, working |
| GeoJSON export adds the campus boundary and snapped footprint | **New**, working |
| **Hallways guessed from shape:** measured rooms that are long and narrow become Corridor (branching open areas become Lobby) on Add room to plan; **Mark as hallways** fixes rooms already on the plan | **New**, working (`test/shape.test.mjs`) |

### Building the map from the campus outline and videos
1. **Floor plan** shows the APU boundary (gold dashed), the main building's footprint, nearby buildings and footpaths under the rooms. **ALL** zooms to the whole campus; **OSM** shows or hides the backdrop.
2. **Draw rooms inside the outline.** Corners snap to the building's corners and walls (10 px to a corner, 7 px to a wall), then to the 0.5 m grid.
3. **Import a walk** (from `worker.py --walk` on a phone video), then use **Move**: drag the corridor and its rooms into place, turn ±5° or ±90°, or **Line up with building**. Group corners snap to building corners.
4. **3D** shows the campus buildings as see-through outlines up to their roof (OSM `building:levels`, else 3; ground = level 1), with the rooms at their real floor height inside.
5. **Place on map** (optional, more exact): fixes the block's real position. Until then the backdrop uses a rough frame, with the plan's centre at the main building's centre and its walls square to the grid.

### How `--map` works (`worker/floormap.py`)
- **One model:** every frame goes into one COLMAP model (3 frames a second), so the hallway and the rooms are placed relative to each other. Up, floor and scale as for `--walk` (shared `walk_frame`).
- **Floor space:** sight lines from cameras to the points they saw, on a 5 cm grid, including floor points. Wall points 0.3–1.9 m up are solid unless other frames see straight through them (stray points from a badly placed frame); points above door heads don't count, so doorways stay open.
- **Split at doorways:** parts wider than 1.1 m are grown from their middles until they meet, so they meet in the doorways. Outlines are squared, snapped to walls, and facing walls under 0.6 m apart go on one line.
- **Doors and types:** a door in each doorway, on the room side; Corridor/Lobby by shape (same rule as the app). Door signs name the room behind the nearest door.
- **Import:** same-ID rooms get the new outline and doors (old one in History). With 2+ matches the map is lined up with them, else placed beside; new rooms are `B-04-R1`…, `B-04-HALL`.

### Test results for `--map` (rendered floor: 20 × 2.4 m hallway, rooms 5 × 5, 5.85 × 4, 6 × 5 m, 0.9 m doors, 89 s walk)
| Check | Result |
|---|---|
| Frames placed (3/s) | 238 / 238 (28 blurry of 266 dropped first), median 0.10 m from the truth |
| Parts | 1 corridor + 3 rooms, 3 doorways |
| Room walls | within 0.18 m |
| Doors | within 0.09 m; 0.75–0.8 m wide (true 0.9) |
| Signs | 3 / 3 matched to the right room |
| Hallway | first 2.1 m (unseen, beside where filming started) missing |
| Import → Directions (headless Chromium) | all 3 room-to-room routes through the hallway, correct turns, no errors |
| At 2 frames/s | 3 frames lost at a door; COLMAP bent the rest by up to 5 m and one room joined the hallway |
| Run time | 19m28s for 238 frames on this sandbox's CPU |
| Unit tests | `python -m unittest test_map`: 4 pass (doorway split, shared walls and doors, thin walls kept, shapes) |

Two bugs in the test renderer were found and fixed on the way: both faces of a wall showed the same texture (COLMAP matched the hallway side to the room side), and two rooms drew their shared wall twice in the same place (flicker).

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
| F9 | Walks aren't aligned to existing rooms automatically | Placed by hand with the Move tool (drag, turn, line up with building, snap to the outline) | Align by shared door signs |
| F10 | A sign seen only side-on was missed | Missing rooms on fast walks | Slow down at signs, or `--fps 3` |
| F11 | Walks aren't joined | Two walks of one hallway overlap | Merge at shared signs/junctions |
| F12 | APU's main building is one OSM outline | Snap to building only turns a block; its position inside is by hand | Map `building:part` per block in OSM, then refresh the snapshot |
| F14 | `--map` misses the hallway behind and beside where filming starts | First 1–2 m of the hallway short | Start filming facing back down the hallway, or draw the end by hand |
| F15 | `--map` needs the whole walk in one COLMAP model; a bad stretch can join a room to the hallway | Room merged with the hallway on the import | Film more slowly; 3 frames/s by default; fix on the Floor plan |
| F13 | No entrances in OSM | No outdoor routing between buildings yet | Add `entrance=*` nodes for the main doors in OSM |

F4 and F8 from earlier reports are unchanged and not blocking.

---

## 3. Campus outline from OpenStreetMap (OSM)

**Why:** it gives a real campus perimeter and building outline to draw rooms and place walks inside, a check on block placement, and footpaths for outdoor routing later. Corridors and rooms still come from walks and photos; OSM has nothing indoors.

### What's in the snapshot (2026-10-20, 330 KB)
| Data | Found | Note |
|---|---|---|
| Campus boundary | 1: "Asia Pacific University of Technology & Innovation" (`way/944352525`, about 45,000 m²) | Fully inside the query area |
| Buildings | 389 in the area; **1 inside the boundary**: APU's main building (`way/541804093`, unnamed, 10 levels, about 17,200 m²) | OSM doesn't split it into Blocks A, B and so on |
| Footpaths and service roads | 267, of which 3 are covered | Covered walkways are mostly unmapped |
| Entrances | 0 | Needed for outdoor routing |

### How it works
- **Data:** `node scripts/osm-campus.mjs` runs one Overpass query (boundary, buildings, paths, entrances) and saves the raw JSON to `web/data/apu-campus.osm.json`. The query lives in `web/index.html` (`CAMPUS_QUERY`), so the app and the script always ask the same thing. The script sends a named User-Agent (Overpass answers HTTP 406 without one), tries three servers, and retries once after 30 s. It also takes a file exported from overpass-turbo.eu. The app loads the snapshot first; without one it asks Overpass from the browser and caches the answer for 7 days. The cloud sandbox can't reach Overpass, so refresh it from a normal connection.
- **Place on map:** draws the boundary, buildings, footpaths and entrances. **Snap to building** finds the rotation from the dominant wall direction of plan and footprint (4-way search by overlap, as `place()` in `worker/floorplan.py`) and the position from area centroids. If the plan is less than half the footprint's area, as with Block B in APU's single main building, it only turns the block to line up with the walls (the turn closest to the current one) and leaves the position to the person. The building id is saved as `geo.osm` (validated as `way/N` or `relation/N`).
- **Backdrop and Move tool:** see §1. The Move tool picks the room you press plus every room within 0.3 m of it, so a walk's corridor and rooms move as one. Stair directions follow 90° turns.
- **Export:** GeoJSON adds `campus_boundary` and the snapped `building_footprint`, credited "© OpenStreetMap contributors, ODbL". The 3D campus outlines stay out of the GLB.

### Tests
| Check | Result |
|---|---|
| `test/campus.test.mjs` | Parsing, multipolygon rings; snap recovers a 30° and a −120° turn within 1°, corners within 0.5 m |
| Snap on the real snapshot (headless Chromium) | Block B turned to 37.6°, `geo.osm` saved, export correct |
| Backdrop and Move tool (headless Chromium) | 391 backdrop shapes drawn; a draw point snapped onto a building corner; a walk imported at 20° moved, lined up to 0.01°, turned 90°; 3D drew the building; OSM toggle hides it; no page errors |
| `npm test` | 12 tests: 11 pass, 1 skipped (the Postgres API test runs only with `TEST_DATABASE_URL`) |

### Open
- **Blocks inside the main building** are placed by hand. To snap them fully, draw the block outlines in OSM (`building:part=*`) and refresh the snapshot, or align by shared door signs (F9).
- **Outdoor routing** (footpaths → graph → each block's ground-floor entrances) needs the main entrances added in OSM first.
- **Accuracy:** OSM footprints can be a few metres off, and the rough frame (before Place on map) is only as good as the building's centre.

---

## 4. Next steps

| Priority | Task | Why |
|---|---|---|
| P0 | Film one real APU floor (hallway plus each room), run `--map`, import; it replaces the jagged B-04-xx scans with connected rooms and doors | Proves `--map` on a real floor |
| P0 | F1: film 2–3 real APU corridors, run `--walk`, import, place them in the outline with Move; tune OCR confidence and `SIGN` regex to APU signs | Proves the video pipeline outside the renderer |
| P0 | Use the backdrop to place Block B (and its walks) inside the main building, then **Place on map** to fix its real position | Gives every later walk a correct frame |
| P1 | Align a walk to existing rooms by shared door signs (4-way rotation search, as `place()` in `floorplan.py`) | Walks join the plan without hand placement (F9) |
| P1 | Merge overlapping corridors into one polygon | More walks → better map (F11) |
| P1 | "Walk" session in Live camera (ordered, timestamped frames) + server-mode `--walk` | No laptop step for contributors |
| P2 | Map APU's block outlines (`building:part`) and main entrances in OSM, then refresh the snapshot | Full snap per block (F12); entrances for outdoor routing (F13) |
| P2 | Outdoor routing over OSM footpaths | Directions between buildings |
| P2 | F6: R2/S3 media storage | Video uploads at scale |
| P3 | MASt3R/DUSt3R for blank corridors; visual place recognition | Robustness, markerless "you are here" |

---

## 5. Quick reference

```sh
# Setup (Python 3.10–3.13); ffmpeg and OCR come with the requirements
cd worker && python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Trace a corridor, then Floor plan → Import walk
python worker.py --walk --video corridor.mp4 [--floor 3] [--block B] [--no-ocr]

# Map a floor (hallway, rooms, doors), then Floor plan → Import walk or map
python worker.py --map --video floor.mp4 [--floor 4] [--block B] [--no-ocr]

# Measure one room
python worker.py --video walk.mp4 --plan plan.json --room B-03-02
python worker.py --photos session-42-B-03-02.zip --plan plan.json

# Connected to the website (room sessions)
python worker.py --server https://your-app.vercel.app --key YOUR_WORKER_KEY

# Tests
python -m unittest test_walk test_map # worker (in worker/)
npm test                              # API validation + campus outline

# OSM campus snapshot (normal internet connection; not the cloud sandbox), then commit web/data/apu-campus.osm.json
node scripts/osm-campus.mjs [overpass-export.json]

# Local site with the API (needs Postgres for shared saving; without it the plan stays in the browser)
npm install && npm run dev
```
