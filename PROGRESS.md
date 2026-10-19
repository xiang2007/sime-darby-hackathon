# UCampass(PIC): progress report

Last updated: 2026-10-19 · Branch: `ccr-cb2de300-h5m2os`

**Goal:** students get indoor directions from room A to room B, from a map that ordinary phones can build from photos or video. Exact room sizes aren't needed. What matters is the hallways, how rooms connect, and a rough sense of distance.

---

## 1. What has been done

### Already in the app before this round (from `main`)
| Area | Status |
|---|---|
| Floor plan editor (rooms, doors, floors, stairs and lifts) | Working |
| **Directions**: routes room to room and across floors, step-free option, deep links | Working, but it runs over the **hand-drawn** plan |
| 3D outline view and GLB, GeoJSON and JSON export | Working |
| **Contribute**: in-browser photo checks (blur, exposure, blank wall, overlap) and **Live camera** auto-capture, up to 80 frames | Working |
| Optional photo upload to Neon Postgres (EXIF and GPS stripped) | Working, capped by the free 0.5 GB tier |
| Optional GPS tag for sessions, "Place on map" for the block | Working (10–50 m accuracy indoors) |
| Python worker (COLMAP) that measures a room from photos, with scale from the door QR marker | Tested on **rendered** rooms only |

### Done in this round
1. **Reviewed the approaches** and decided:
   - **2D photo → 3D.** Single-image or generative 3D isn't reliable for measurement. Learned multi-view models (MASt3R/DUSt3R) are useful for a rough **path or trajectory**, which is what navigation needs.
   - **GPS** is only good for placing and orienting the whole block on a map, not for working out rooms.
   - **QR markers:** making people print markers defeats the crowdsourcing idea. An audit of the code showed markers are **already optional** everywhere except metric scale in the worker, which routing doesn't need.
   - **Video vs photos:** video is easier for contributors. In-browser frame picking stays the default for phone uploads.
2. **Implemented `--video` mode for the worker** (commit on this branch):
   - `worker/video.py` extracts frames with **ffmpeg** (default 2 fps, up to 2048 px, audio removed).
   - It filters frames with the **same checks as the app** (`QC` in `web/index.html`): sharpness ≥ 80, brightness 45–235, texture ≥ 0.035, minimum side ≥ 480 px. It also drops near-duplicate frames and thins the rest evenly to `--max-frames` (default 80).
   - `worker/worker.py` adds the `--video`, `--fps`, `--max-frames` and `--ffmpeg` options and feeds the frames into the existing `process()` pipeline.
   - The README explains how to use it and gives filming tips.
   - Usage: `python worker.py --video walk.mp4 --plan plan.json --room B-03-02`

---

## 2. What failed or isn't verified yet

| # | Problem | Impact | Suggested fix |
|---|---|---|---|
| F1 | **End-to-end `--video` → COLMAP → result not tested.** `pycolmap` isn't installed in the dev container, so only frame extraction and filtering were tested (synthetic 20 s video: 40 frames, 28 kept, blurry/dark/blank frames correctly dropped). | Unknown whether real phone video reconstructs well. | On a laptop: `pip install -r worker/requirements.txt`, record a 30–60 s hallway walk and run `python worker.py --video walk.mp4`. Check `preview.png`. |
| F2 | **ffmpeg wasn't installed** in the dev environment. I worked around it with the `imageio-ffmpeg` binary for testing. Contributors' laptops may not have ffmpeg either. | `--video` exits with "ffmpeg wasn't found". | Option A: document installing ffmpeg (already in the README). Option B (better): add `imageio-ffmpeg` to `worker/requirements.txt` and use its bundled binary when `ffmpeg` isn't on PATH. |
| F3 | **Not deployed.** Vercel deploys only `main`, and no PR has been opened yet. | The website is unchanged. This only matters for docs, because the worker runs locally. | Open a PR from `ccr-cb2de300-h5m2os` → `main` and merge it. |
| F4 | **The worker has never run on a real room.** The README's accuracy numbers come from rendered scenes. | Glass, blank walls and people walking past may break reconstruction. | Test on 2–3 real APU rooms and hallways, and record the success rate in the README. |
| F5 | **Scale without a marker is rough** (phone held at 1.45 m), and the floor is sometimes not reconstructed, so there's no height. | Distances can be 5–10%+ off. | Acceptable for navigation. Later, use step count or walking pace, or ARCore/ARKit depth if you go native. |
| F6 | **Photos and video can't be crowdsourced at scale:** 80-photo cap per session, Neon 0.5 GB ≈ 500–1,000 photos, Vercel request body limit of a few MB. | The free tier fills quickly, and phone video uploads aren't possible. | Move media to **Cloudflare R2 or S3 with presigned uploads**, and keep only metadata in Neon. |
| F7 | **Directions only works if someone draws the plan by hand.** Photos only *measure* rooms that are already drawn; they don't create corridors or links. | This is the biggest gap for the core goal. | See the crucial next step below. |
| F8 | Some session integrations (GitHub MCP plugin, analytics plugins) failed to connect in the dev session (proxy 403). | Didn't affect the code. | None needed. Git push worked normally. |

---

## 3. The next crucial step

### Build the hallway map from walks: trajectory → corridor graph
Directions is already built. What's missing is **creating the map without drawing it by hand**. The next step should be:

1. **Worker: output the walking path, not just a room outline.**
   - From the video or Live camera frames, take the **camera trajectory** (COLMAP poses now; MASt3R/DUSt3R later for blank corridors).
   - Simplify it into a polyline (corridor centreline), flatten it to the floor plane and scale it roughly by phone height.
2. **Find the rooms along the path without QR codes.**
   - Run **OCR on door signs** (for example "B-03-02") in the kept frames, and attach each reading to the closest point on the path. Contributors can correct it in the app.
   - Keep QR markers as an optional, more accurate source.
3. **Merge into the plan.**
   - Turn the path into a corridor "room" (a buffer about 2 m wide) and add doors where signs were seen. The existing `navGraph()` in `web/index.html` then routes over it with no changes.
   - Join walks from different contributors at shared signs or junctions.
4. **Start point without markers:** the "From" list (already there), then sign OCR from a photo, then later visual place recognition against the contributors' frames.

**Definition of done for the demo:** walk one APU corridor with a phone → run the worker → a corridor and its room doors appear on the Floor plan → Directions finds a route between two of those rooms.

### Order of work
| Priority | Task | Why |
|---|---|---|
| P0 | F1: test `--video` end-to-end on a real hallway | Proves the input pipeline before building on it |
| P0 | Trajectory → corridor polyline output in the worker | The core of the product |
| P1 | Door-sign OCR → room nodes on the path | Removes the dependency on QR codes |
| P1 | "Apply walk to plan" button (like the existing "Use measured outline") | Turns photos into routable data |
| P2 | F2: bundle ffmpeg via `imageio-ffmpeg` | Smoother setup for the demo |
| P2 | F6: R2/S3 media storage | Needed only beyond the hackathon scale |
| P3 | MASt3R/DUSt3R backend, visual place recognition, sensor dead reckoning | Better robustness and markerless "you are here" |

---

## 4. Quick reference

```sh
# Worker setup (laptop, Python 3.10–3.13)
cd worker && python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt          # also install ffmpeg for --video

# Connected to the website
python worker.py --server https://your-app.vercel.app --key YOUR_WORKER_KEY

# Offline: photos zip, or a video
python worker.py --photos session-42-B-03-02.zip --plan plan.json
python worker.py --video walk.mp4 --fps 2 --max-frames 80 --plan plan.json --room B-03-02
```
