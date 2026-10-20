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

## 3. Next steps

| Priority | Task | Why |
|---|---|---|
| P0 | F1: run `--walk` on real APU corridors; tune OCR confidence and `SIGN` regex to APU signs | Proves it outside the renderer |
| P1 | Align a walk to existing rooms by shared signs (4-way rotation search, as `place()` in `floorplan.py`) | Walks build up one plan |
| P1 | Merge overlapping corridors into one polygon | More walks → better map |
| P1 | "Walk" session in Live camera (ordered, timestamped frames) + server-mode `--walk` | No laptop step for contributors |
| P2 | F6: R2/S3 media storage | Video uploads at scale |
| P2 | OSM building footprints and footpaths (fetch once, store as GeoJSON) | Block placement, outdoor routes |
| P3 | MASt3R/DUSt3R for blank corridors; visual place recognition | Robustness, markerless "you are here" |

---

## 4. Quick reference

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
python -m unittest test_walk
```
