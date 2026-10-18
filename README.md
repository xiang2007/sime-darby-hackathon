# UCampass(PIC)

UCampass(PIC) is a crowdsourced web app for mapping a building as a labelled 3D outline (rooms, walls, doors, floors and stairwells) from photos contributed by ordinary phones. The example target is the APU campus, starting with one block.

**Live:** deployed on Vercel from this repo. It also runs as a [claude.ai artifact](https://claude.ai/artifact/EWr8GzRBKErHG9igFdL71C).

---

## What's new

- **Live camera.** On **Contribute**, tap **Live camera**, keep it open and walk slowly. The app keeps a photo whenever the view is sharp, not a blank wall, and has moved on from the last one, takes a few shots of any door marker it reads, and stops at 80 photos. The photos then go through the usual checks and upload.
- **Optional GPS tag.** A session can be tagged with the phone's GPS position. It links to a map from **Sessions**, and the GeoJSON export gets a rough `anchor` position for the block. Indoor GPS is usually only accurate to 10–50 m, so it places the building, not the rooms; room shapes still come from the photos. Uploaded photos never carry location.
- **Measure rooms from photos.** A worker program on your own laptop turns uploaded photos into a measured room outline and ceiling height, using the door marker for scale. Compare it with the drawn room on the Floor plan tab and apply it in one click. [How to run it](#measuring-rooms-from-photos)
- **Photos saved in the database.** Contributors can choose to upload their photos. They're stored in the same Neon database as the plan, with GPS and other hidden data removed. View them or download a zip from Sessions.
- **Works on phones.** Bottom tab bar, pull-up room details, and touch drawing, panning and zooming.
- **New name:** UCampass(PIC).

**To turn on 3D measuring:** add `WORKER_KEY` in Vercel and redeploy, then on a laptop run `python worker.py --server https://your-app.vercel.app --key YOUR_WORKER_KEY` inside `worker/` ([full steps](#run-it)).

---

## What it does

| Tab | Purpose |
|-----|---------|
| **Floor plan** | Draw rooms on a 0.5 m grid, add doors, set each room's ID, type and height. Print QR markers for doors. Compare a room with its measurement from photos and apply it in one click. |
| **3D outline** | Turns the plan into a 3D model: walls with door openings, stacked floors and real stairs. Export as GLB, GeoJSON or JSON. |
| **Contribute** | Checks photos for blur, exposure, blank walls and overlap, and reads door QR codes. Photos stay on the phone unless the contributor ticks **Also upload the photos**. Uploaded photos can be viewed and downloaded as a zip from **Sessions**. |
| **Sessions** | Shows who scanned what, whether it passed, which rooms still need scanning, and each session's 3D measurement. |
| **History** | Every edit is saved as a version that can be restored. |

**On phones** the tabs move to a bottom bar, room details open in a pull-up sheet, and the plan supports tap to draw, drag to pan and pinch to zoom.

Several people can edit at once. Edits to different rooms merge automatically; if two people change the same room, the app asks whose version to keep.

### Stairwells

A room of type **Stairs / lift** is built as a link between floors:

- **Switchback** (default): two flights with a landing halfway. **Straight**: one flight. **Lift**: a shaft with a car.
- Step height is fitted to the floor height (3.6 m gives 22 steps of 164 mm). The room panel warns when steps, landings or flights are too small.
- Stairs can be turned and mirrored. Draw stairwells as rectangles, in the same place on each floor.

---

## How it works

```
web/index.html   the whole front end (plan editor, 3D view, photo checks)
api/             Vercel serverless functions
lib/             database, validation and HTTP helpers
scripts/         Vercel build and local dev server
test/            API tests
worker/          the 3D measuring worker, run on your own computer (Python)
```

- **Front end:** a single HTML page using Three.js. It checks the server for changes every 4 seconds.
- **Back end:** Vercel functions on Postgres. Six tables (`plan`, `versions`, `sessions`, `photos`, `recon`, `workers`) are created automatically on first use.
- **Photos:** opt-in. The phone resizes each usable photo to 2048 px and re-encodes it, which strips GPS and other EXIF data, then uploads them one at a time. They're stored as JPEG bytes in the `photos` table of the same Neon database, and only served back through `/api/photos`. At about 0.5–1 MB a photo, Neon's free 0.5 GB holds roughly 500–1,000 photos. Each session reserves its number of photos up front; uploads beyond that, or more than 2 hours later, are refused.
- **3D measuring:** a worker on your own computer measures each room from its uploaded photos. See [Measuring rooms from photos](#measuring-rooms-from-photos).
- **Saving:** each save includes the version it was based on. If someone else saved first, the server rejects it and the app merges room by room.
- **Safety:** all input is checked field by field before it's stored. Setting `EDIT_KEY` makes every change require that key.
- **No database?** The site still works, saving to each visitor's browser, and shows a banner saying so.

| Route | Purpose |
|-------|---------|
| `GET /api/health` | Is a database connected? Is photo storage set up? Is an edit key needed? |
| `GET /api/state` | Current plan, recent versions and sessions |
| `PUT /api/plan` | Save the plan (returns 409 if someone saved first) |
| `GET /api/versions?rev=N` | Fetch an old version |
| `POST /api/sessions` | Submit a capture session (`photos`: how many it will upload) |
| `POST /api/photos?session=&i=&w=&h=` | Upload one JPEG for a session |
| `GET /api/photos?session=ID` / `?id=ID` | List a session's photos / fetch one |
| `POST /api/jobs` | Worker: claim the next session to measure |
| `PUT /api/jobs?session=ID` | Worker: report the measurement, or why it failed |
| `GET /api/jobs?session=ID` | A session's full measurement, for the plan overlay |
| `DELETE /api/jobs?session=ID` | Measure a session again |

---

## Setup

**On Vercel** (every push deploys automatically):

1. **Storage → Create Database → Neon (Postgres)**, connected to this project. This sets `DATABASE_URL`.
2. Photo uploads need nothing extra: they're stored in the same database. To turn them off, set `PHOTO_UPLOAD=off`; the upload option is then hidden and photos stay on phones.
3. For 3D measuring: add `WORKER_KEY` under **Settings → Environment Variables**, set to a long random password. The worker uses it to connect. Without it, no worker can connect.
4. Optional: add `EDIT_KEY` too. It's then also needed to view photos.
5. Redeploy.

**Locally:**

```sh
npm install
DATABASE_URL=postgres://user:pass@localhost/apu npm run dev          # http://localhost:3000
TEST_DATABASE_URL=postgres://user:pass@localhost/apu_test npm test   # wipes that test database
```

---

## Measuring rooms from photos

The worker turns a contributor's photos into a measured room outline and ceiling height. It runs on any laptop or PC, not on Vercel, and needs no graphics card.

**How it works**

1. [COLMAP](https://colmap.github.io/) works out where each photo was taken and builds a 3D point cloud of the room.
2. "Up" comes from the photos themselves: a phone's left-right edge stays level, however it's tilted.
3. The floor and ceiling are the lowest and highest flat layers of points. Their distance apart is the ceiling height.
4. **Scale comes from the door marker.** Its printed size is known (about 5.4 cm), so measuring it in the 3D model converts everything to metres. Without a usable marker, the worker assumes the phone was held about 1.45 m above the floor, which is rougher, and marks the result low confidence.
5. Walls: the space each photo could see through is carved out on a 5 cm grid, squared up to the room's main directions, and each wall is snapped to the points found on it. Doorways and windows narrower than 1 m are cut off, so the outline stops at the wall.
6. The outline is placed over the room as drawn on the plan (matched by room tag), so the two can be compared.

On the **Floor plan** tab, pick the room and look under **Measured from photos**: measured and drawn sizes side by side, the ceiling height, and where the scale came from. **Show on plan** draws the measured outline and wall points over the drawing. **Use measured outline** replaces the drawn shape and height; doors move to the nearest point on the new outline, and the old shape stays in History. If the room isn't on the plan yet, **Add room to plan** on the Sessions tab creates it.

### Run it

Needs Python 3.10–3.13.

```sh
cd worker
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python worker.py --server https://your-app.vercel.app --key YOUR_WORKER_KEY
```

It checks for new sessions every 20 seconds and keeps running until you stop it with Ctrl+C. The Sessions tab shows the worker as **Live** while it runs. A session is measured once its upload is finished, if it has at least 8 photos and wasn't rejected. Measuring takes about 4–8 minutes for 50–80 photos on a 4-core laptop.

- `--once` measures one session, then stops.
- `--session 42` measures session 42 again.
- **Try again** on the Sessions tab re-queues a failed session.
- Offline, on a zip from **Sessions → View → Download all**: `python worker.py --photos session-42-B-03-02.zip --plan plan.json`. Here `plan.json` is the plan exported from the Floor plan tab. This writes `result.json` and `preview.png` (a top-down picture of the points, cameras and outline).

**Tested accuracy.** The worker was tested on two rendered rooms of known size, not yet on real rooms.
- **L-shaped room, 7.2 × 5.4 m, 3.0 m ceiling:** measured 7.23 × 5.42 m, with a 2.98 m ceiling. Using the phone-height fallback instead of the marker, it measured 7.28 × 5.46 m.
- **Rectangular room, 8.4 × 6.0 m:** photos taken with hand-held tilt and varying height. Measured 8.40 × 6.00 m, and the door marker was placed within 1 cm. The ceiling height wasn't reported: too little of the floor was reconstructed to measure from.

Real rooms will be less exact: glass, mirrors, blank walls and moving people all reduce accuracy. When something couldn't be measured, the worker says so rather than guessing.

**Getting good measurements.** The Contribute tab shows these tips when a contributor opts in:
- Take 2–3 close photos of the door marker from different angles.
- Walk along the walls and turn slowly at corners, so photos overlap across each corner.
- Add a few photos tilted up at the ceiling and down at the floor.
- Print markers at 100% size.

---

## How it was built

1. **Plan:** wrote the pipeline below from the original 3DGS research guide.
2. **Web app:** built a single-page app covering the steps that don't need a GPU: floor plan, 3D outline, photo checks, sessions and history. Published it as a claude.ai artifact.
3. **Vercel:** added a build step so the same page deploys to Vercel on every push.
4. **Full stack and stairwells:** added the Postgres API, live sync between editors, room-by-room merging and an optional edit key. Added real stairs and lift shafts to the 3D model. Tested with 12 API tests and two-browser tests against a local database.
5. **Phones and photo upload:** made the layout work on phones (bottom tabs, pull-up room sheet, touch drawing) and renamed the app UCampass(PIC). Added opt-in photo upload, stored in the Postgres database, with a photo viewer and zip download, so sessions can feed a reconstruction server.
6. **3D measuring:** added the local worker (COLMAP through pycolmap, then floor, ceiling and wall fitting with marker scale), a job queue in Postgres, and the Floor plan comparison, overlay and apply. Tested on rendered rooms with known sizes, end to end through the phone UI.

**Not built yet:** 3D Gaussian Splatting (pipeline steps 7–8) for photoreal views. The outline doesn't need it.

---

## The full pipeline

The goal is to turn crowdsourced phone photos into a clean building model. 3D Gaussian Splatting (3DGS) gives photoreal reconstructions but doesn't produce walls or rooms, and separate splat models can't be merged. So photos are merged first, splats are trained second, and clean geometry is extracted last.

| # | Step | Key tools | In the app? |
|---|------|-----------|-------------|
| 1 | Define room and element classes; start with one floor | — | ✅ room types |
| 2 | Get campus permission; plan for privacy (PDPA) | — | ✅ photos stay on device unless shared; EXIF removed |
| 3 | Capture with AR poses; put QR markers on doors | ARKit / ARCore | ✅ QR markers |
| 4 | Upload sessions to a job queue | FastAPI, S3, Celery, PostGIS | ✅ opt-in photo upload into Postgres, job queue for the worker |
| 5 | Blur faces, mask people, reject bad photos | SAM, YOLO | ◐ quality checks, no face blur |
| 6 | Register all sessions into one coordinate system | hloc, COLMAP, GTSAM | ◐ COLMAP per session, scaled by the door marker (local worker) |
| 7 | Train splats block by block, with depth supervision | 2DGS, PGSR, gsplat | ❌ needs GPU |
| 8 | Extract a mesh from the splats | Open3D TSDF | ❌ needs GPU |
| 9 | Find walls, floor and ceiling; draw the floor plan | RANSAC (Open3D) | ✅ measured by the worker, reviewed on the plan |
| 10 | Split the floor into rooms at doorways | OpenCV, Shapely | ✅ manual drawing |
| 11 | Label rooms from QR codes, signs or a classifier | PaddleOCR | ✅ QR + manual |
| 12 | Extrude to 3D and stack floors, using stairwells as anchors | — | ✅ 3D outline |
| 13 | Human review editor with version history | — | ✅ editor + history |
| 14 | Export the outline (GLB, GeoJSON) and a splat viewing layer | SPZ, Spark | ✅ outline exports |

**Main risks:** training needs a GPU; blank walls, glass and mirrors cause false depth; drift between floors (which stairwell markers help fix); older phones without AR can't take part.

**If you only need the outline, splats are optional.** Steps 1–6 and 9–14 are enough; 3DGS can be added later as a viewing layer.
