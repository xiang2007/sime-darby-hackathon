# UCampass(PIC): progress report

Last updated: 2026-10-19 · Branch: `claude/vigilant-mayer-cuzfx0`

**Goal:** students get indoor directions from room A to room B, from a map that ordinary phones can build from photos or video. Exact room sizes aren't needed. What matters is the hallways, how rooms connect, and a rough sense of distance.

---

## 1. What has been done

### Already in the app (from `main`)
| Area | Status |
|---|---|
| Floor plan editor (rooms, doors, floors, stairs and lifts) | Working |
| **Directions**: routes room to room and across floors, step-free option, deep links | Working |
| 3D outline view and GLB, GeoJSON and JSON export | Working |
| **Contribute**: in-browser photo checks and **Live camera** auto-capture, up to 80 frames | Working |
| Optional photo upload to Neon Postgres (EXIF and GPS stripped) | Working, capped by the free 0.5 GB tier |
| Optional GPS tag for sessions, "Place on map" for the block | Working (10–50 m accuracy indoors) |
| Python worker (COLMAP) that measures a room from photos | Tested on rendered rooms only |
| Worker `--video` mode: frames picked from a video with the app's quality checks | Working |

### Done in this round: map a corridor by walking it (the "crucial next step" from the last report)
1. **Worker `--walk` mode** (`worker/walk.py`, wired into `worker.py`):
   - Takes the camera path from COLMAP, uses the walk's own plane to find "up", and finds the floor.
   - Scale from phone height (1.45 m), **checked against walking pace** (1.25 m/s) when the input is a video. The result says whether they agree.
   - Squares the path to the building's main directions and splits it into straight runs. It finds **both walls of each run** from the 3D points (real width, not a fixed buffer) and continues the corridor to its end walls when they were filmed.
   - **Door-sign OCR** (RapidOCR, CPU only) reads codes like `B-03-02`. QR door markers are still read, but are optional. Each sign is placed by crossing the sight lines from the frames that saw it. A one-off misread beside a real sign is dropped.
   - Adds a **placeholder room** (up to 4 × 4 m) behind each door, sized so rooms don't overlap the corridor or each other.
   - Writes `walk.json` and `preview.png`. The floor and block come from the signs, or from `--floor` / `--block`.
   - Walks use sequential matching (each frame against its neighbours) instead of matching every pair, which scales to longer walks.
2. **App: Import walk** (Floor plan → no room selected → *Walks* → **Import walk**). Adds the corridor with its doors and the placeholder rooms. Rooms already on the plan aren't duplicated. Directions routes over the result with no changes.
3. **F2 fixed:** `imageio-ffmpeg` is in `worker/requirements.txt`, and the worker uses its bundled ffmpeg when none is installed.
4. **Unit tests** for the walk geometry: `cd worker && python -m unittest test_walk` (8 tests).

### How it was tested
A rendered L-shaped corridor (24 m and 14 m arms, 2.4 m wide, 3 m high, five door signs on 40 cm plates) was filmed as a 27-second walk and encoded to MP4. Then `python worker.py --walk --video corridor.mp4` ran end to end, with real pycolmap and real OCR:

| Check | Result |
|---|---|
| Frames placed by COLMAP | 46 of 46 |
| Corridor area | 81–86 m² (true 85.4 m²) |
| Corridor width | 2.35–2.6 m (true 2.4 m) |
| Scale: phone height vs walking pace | agree within 1% |
| Door signs read | 4 of 5, each door 0.1–0.5 m from its sign; 1 misread correctly dropped |
| Import walk → Directions in headless Chromium | Route found between two new rooms, with correct left/right turns, no page errors |

**Definition of done from the last report, met on the rendered corridor:** walk a corridor → run the worker → a corridor and its room doors appear on the Floor plan → Directions finds a route between two of those rooms.

---

## 2. What failed or isn't verified yet

| # | Problem | Impact | Suggested fix |
|---|---|---|---|
| F1 | **Not yet run on a real corridor.** The pipeline is now tested end to end, but only on a rendered video. | Glass, plain walls, people walking past, motion blur and real signs (fonts, glare, logos) are untested. | Film 2–3 APU corridors with the README's filming tips, then run `python worker.py --walk --video x.mp4` and check `preview.png`. Record the results in the README. |
| F3 | **Not deployed.** Vercel deploys only `main`. | Import walk isn't on the live site yet. | Open a PR from `claude/vigilant-mayer-cuzfx0` → `main` and merge it. |
| F5 | **Scale without a marker is rough.** | Distances can be 5–10% off. The walking-pace check now flags big errors. | Acceptable for navigation. |
| F6 | **Photos and video can't be crowdsourced at scale** (80-photo cap, Neon 0.5 GB, Vercel body limit). | Walk videos can't be uploaded through the app, so `--walk` is offline only. | Cloudflare R2 or S3 with presigned uploads; then a "walk" session type the worker picks up like room sessions. |
| F9 | **A walk isn't lined up with rooms already on the floor.** On a non-empty floor it's placed beside them, and the editor can't move a group of rooms. | Fine for a new floor. Merging into an existing plan needs manual redrawing. | Align by shared door signs (rotate and move so matching rooms line up), and add "move selection" to the editor. |
| F10 | **One sign was never read** in the test (seen only side-on at 2 frames per second). | Missing rooms on fast walks. | Filming tip: slow down at signs. Or use `--fps 3`. |
| F11 | **Several walks aren't joined yet.** Each import is its own corridor. | Two walks of the same corridor overlap instead of merging. | Join walks at shared signs or junctions (see next step). |

F2 (ffmpeg missing) is fixed. F7 (Directions only works over hand-drawn plans) is solved for corridors. F4 and F8 from the last report are unchanged and not blocking.

---

## 3. The next crucial step

### Test on a real APU corridor, then join walks into one floor plan
1. **Real-world test (P0).** Film one APU corridor with known room numbers and run `--walk`. Check the shape, the width, and which signs were read. Tune the OCR confidence and the room-code pattern (`SIGN` in `worker/walk.py`) to APU's actual sign style.
2. **Align and join walks (P1).**
   - When a walk shares door signs with rooms already on the plan, rotate and move it so they line up. This uses the same 4-way rotation search as `place()` in `floorplan.py`.
   - Merge overlapping corridors into one polygon, so two people walking the same hallway improve it instead of duplicating it.
3. **Walk sessions through the app (P1–P2).** Let Live camera record a "walk" session (frames in order, with timestamps) that the worker traces with `--walk` in server mode. Uploading long videos needs F6.
4. **Outdoor layer (P2).** Fetch APU building footprints and footpaths from OpenStreetMap once, save them as GeoJSON, and use them to place blocks and route between buildings.

### Order of work
| Priority | Task | Why |
|---|---|---|
| P0 | F1: run `--walk` on 2–3 real APU corridors | Proves it outside the renderer |
| P1 | Align a walk to existing rooms by shared signs | Lets walks build up one plan |
| P1 | Merge overlapping walks | Crowdsourcing: more walks give a better map |
| P1 | "Walk" session type in Live camera plus server-mode `--walk` | No laptop step for contributors |
| P2 | F6: R2/S3 media storage | Needed for video uploads and scale |
| P2 | OSM building footprints and footpaths | Block placement and routes between buildings |
| P3 | MASt3R/DUSt3R backend for blank corridors, visual place recognition | Robustness and markerless "you are here" |

---

## 4. Quick reference

```sh
# Worker setup (laptop, Python 3.10–3.13); ffmpeg and OCR come with the requirements
cd worker && python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Trace a corridor from a walk, then Floor plan → Import walk
python worker.py --walk --video corridor.mp4 [--floor 3] [--block B] [--no-ocr]

# Measure one room
python worker.py --video walk.mp4 --plan plan.json --room B-03-02
python worker.py --photos session-42-B-03-02.zip --plan plan.json

# Connected to the website (room sessions)
python worker.py --server https://your-app.vercel.app --key YOUR_WORKER_KEY

# Tests
python -m unittest test_walk
```
