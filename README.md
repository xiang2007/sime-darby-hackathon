# UCampass(PIC)

UCampass(PIC) is a crowdsourced web app for mapping a building as a labelled 3D outline (rooms, walls, doors, floors and stairwells) from photos contributed by ordinary phones. The example target is the APU campus, starting with one block.

**Live:** deployed on Vercel from this repo. It also runs as a [claude.ai artifact](https://claude.ai/artifact/EWr8GzRBKErHG9igFdL71C).

---

## What it does

| Tab | Purpose |
|-----|---------|
| **Floor plan** | Draw rooms on a 0.5 m grid, add doors, set each room's ID, type and height. Print QR markers for doors. |
| **3D outline** | Turns the plan into a 3D model: walls with door openings, stacked floors and real stairs. Export as GLB, GeoJSON or JSON. |
| **Contribute** | Checks photos for blur, exposure, blank walls and overlap, and reads door QR codes. Photos stay on the phone unless the contributor ticks **Also upload the photos**. Uploaded photos can be viewed and downloaded as a zip from **Sessions**. |
| **Sessions** | Shows who scanned what, whether it passed, and which rooms still need scanning. |
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
```

- **Front end:** a single HTML page using Three.js. It checks the server for changes every 4 seconds.
- **Back end:** Vercel functions on Postgres. Four tables (`plan`, `versions`, `sessions`, `photos`) are created automatically on first use.
- **Photos:** opt-in. The phone resizes each usable photo to 2048 px and re-encodes it, which strips GPS and other EXIF data, then uploads them one at a time. They're stored as JPEG bytes in the `photos` table of the same Neon database, and only served back through `/api/photos`. At about 0.5–1 MB a photo, Neon's free 0.5 GB holds roughly 500–1,000 photos. Each session reserves its number of photos up front; uploads beyond that, or more than 2 hours later, are refused.
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

---

## Setup

**On Vercel** (every push deploys automatically):

1. **Storage → Create Database → Neon (Postgres)**, connected to this project. This sets `DATABASE_URL`.
2. Photo uploads need nothing extra: they're stored in the same database. To turn them off, set `PHOTO_UPLOAD=off`; the upload option is then hidden and photos stay on phones.
3. Optional: add `EDIT_KEY` under **Settings → Environment Variables**. It's then also needed to view photos.
4. Redeploy.

**Locally:**

```sh
npm install
DATABASE_URL=postgres://user:pass@localhost/apu npm run dev          # http://localhost:3000
TEST_DATABASE_URL=postgres://user:pass@localhost/apu_test npm test   # wipes that test database
```

---

## How it was built

1. **Plan:** wrote the pipeline below from the original 3DGS research guide.
2. **Web app:** built a single-page app covering the steps that don't need a GPU: floor plan, 3D outline, photo checks, sessions and history. Published it as a claude.ai artifact.
3. **Vercel:** added a build step so the same page deploys to Vercel on every push.
4. **Full stack and stairwells:** added the Postgres API, live sync between editors, room-by-room merging and an optional edit key. Added real stairs and lift shafts to the 3D model. Tested with 12 API tests and two-browser tests against a local database.
5. **Phones and photo upload:** made the layout work on phones (bottom tabs, pull-up room sheet, touch drawing) and renamed the app UCampass(PIC). Added opt-in photo upload, stored in the Postgres database, with a photo viewer and zip download, so sessions can feed a reconstruction server.

**Not built yet:** photo registration and 3D Gaussian Splatting training (pipeline steps 6–8), which need a GPU server.

---

## The full pipeline

The goal is to turn crowdsourced phone photos into a clean building model. 3D Gaussian Splatting (3DGS) gives photoreal reconstructions but doesn't produce walls or rooms, and separate splat models can't be merged. So photos are merged first, splats are trained second, and clean geometry is extracted last.

| # | Step | Key tools | In the app? |
|---|------|-----------|-------------|
| 1 | Define room and element classes; start with one floor | — | ✅ room types |
| 2 | Get campus permission; plan for privacy (PDPA) | — | ✅ photos stay on device unless shared; EXIF removed |
| 3 | Capture with AR poses; put QR markers on doors | ARKit / ARCore | ✅ QR markers |
| 4 | Upload sessions to a job queue | FastAPI, S3, Celery, PostGIS | ✅ opt-in photo upload into the Postgres database (no job queue yet) |
| 5 | Blur faces, mask people, reject bad photos | SAM, YOLO | ◐ quality checks, no face blur |
| 6 | Register all sessions into one coordinate system | hloc, COLMAP, GTSAM | ❌ needs GPU |
| 7 | Train splats block by block, with depth supervision | 2DGS, PGSR, gsplat | ❌ needs GPU |
| 8 | Extract a mesh from the splats | Open3D TSDF | ❌ needs GPU |
| 9 | Find walls, floor and ceiling; draw the floor plan | RANSAC (Open3D) | ✅ manual drawing |
| 10 | Split the floor into rooms at doorways | OpenCV, Shapely | ✅ manual drawing |
| 11 | Label rooms from QR codes, signs or a classifier | PaddleOCR | ✅ QR + manual |
| 12 | Extrude to 3D and stack floors, using stairwells as anchors | — | ✅ 3D outline |
| 13 | Human review editor with version history | — | ✅ editor + history |
| 14 | Export the outline (GLB, GeoJSON) and a splat viewing layer | SPZ, Spark | ✅ outline exports |

**Main risks:** training needs a GPU; blank walls, glass and mirrors cause false depth; drift between floors (which stairwell markers help fix); older phones without AR can't take part.

**If you only need the outline, splats are optional.** Steps 1–6 and 9–14 are enough; 3DGS can be added later as a viewing layer.
