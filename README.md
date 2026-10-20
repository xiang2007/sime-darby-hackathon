# UCampass(PIC)

UCampass(PIC) is a crowdsourced web app for mapping a building as a labelled 3D outline (rooms, walls, doors, floors and stairwells) from photos contributed by ordinary phones. The example target is the APU campus, starting with one block.

**Live:** deployed on Vercel from this repo. It also runs as a [claude.ai artifact](https://claude.ai/artifact/EWr8GzRBKErHG9igFdL71C).

---

## What's new

- **Map a floor, with its doors, from one video.** Film one walk along the hallway that steps into each room, run `python worker.py --map --video floor.mp4`, then **Import walk or map** on the Floor plan tab. The hallway and every room you stepped into come out where they really are relative to each other, with a door in each doorway you walked through, so Directions routes room to room through the hallway. Rooms named by a door sign ("B-04-02") replace the jagged outline already on the plan. [How it works](#mapping-a-floor-from-one-walk)
- **Hallways found from their shape.** Rooms measured from photos used to all arrive as **Other**. Now **Add room to plan** sets a long, narrow scan (under 3.5 m wide and at least 3 times as long as it is wide) to **Corridor**, and a big open area that branches out to **Lobby**. For rooms already on the plan, **Mark as hallways** on the Floor plan tab (no room selected) lists the **Other** rooms that look like hallways and changes them in one click, and a room's panel suggests the change too. Directions prefers corridors and lobbies, so routes keep to the hallways. [How it's measured](#hallways-from-the-shape)
- **Map a corridor by walking it.** Film a slow walk along a corridor, run `python worker.py --walk --video corridor.mp4`, then **Import walk** on the Floor plan tab. The corridor appears with its real shape and width, a door wherever the video shows a room sign like "B-03-02", and a placeholder room behind each door, so Directions can route between those rooms straight away. No QR markers or hand drawing needed. [How it works](#mapping-corridors-from-a-walk)
- **Directions.** The new **Directions** tab gives students a route from one room to another, across floors: a line on the floor plan plus steps like "Turn left into Main corridor and walk 10 m". Tap rooms on the plan or pick them from the lists, or **Scan marker** to start from the door marker you're standing at. **Step-free** keeps to lifts. Links like `/?from=B-03-01&to=B-04-02` open a route directly. [How routes are found](#directions)
- **Place the block on a real map.** On **Floor plan** (no room selected), **Place on map** opens a map: drag it until the outline sits on the building and turn it to match. After that the GeoJSON export uses real map coordinates, Directions can show your GPS position on the plan (rough indoors, so markers are the reliable way to know where you are), and links to Google Maps for getting to the block.
- **Campus outline from OpenStreetMap.** The map also shows the campus boundary (gold dashed line), building footprints and footpaths from OpenStreetMap. Tap a building and press **Snap to building** to fit the block to its outline (position and turn); fine-tune, then save. The 3D view draws the outline faintly on the ground, and the GeoJSON export adds the campus boundary and the snapped footprint. The app loads `web/data/apu-campus.osm.json` if it exists; otherwise it asks Overpass from the browser and keeps the answer for a week. Save a snapshot with `node scripts/osm-campus.mjs` (or pass it a raw JSON file exported from overpass-turbo.eu). Map data © OpenStreetMap contributors, ODbL.
- **Draw inside the real building.** The Floor plan and 3D views show the campus outline as a backdrop: the APU boundary (gold dashed), the main building's footprint, other buildings and footpaths. Room corners snap to the building's corners and walls while you draw or reshape. **ALL** zooms out to the whole campus, and **OSM** turns the backdrop on and off. In 3D the campus buildings appear as see-through outlines up to their roof, so floors can be checked against them. Until the block is placed on the map, the backdrop is lined up roughly: centred on the main building, with its walls square to the grid.
- **Move tool for walks.** **Move** drags a room together with every room joined to it, such as an imported walk's corridor and the rooms behind its doors. Use **⟲ 90° / ⟲ 5° / ⟳ 5° / ⟳ 90°** to turn them, or **Line up with building** to square them to the building's walls. Corners snap to the building outline as you drag.
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
| **Directions** | Route from any room to any other, including between floors by stairs or lift, with a line on the plan and step-by-step instructions. Start from a door marker by scanning it. |
| **3D outline** | Turns the plan into a 3D model: walls with door openings, stacked floors and real stairs. Export as GLB, GeoJSON or JSON. |
| **Contribute** | Checks photos for blur, exposure, blank walls and overlap, and reads door QR codes. Photos stay on the phone unless the contributor ticks **Also upload the photos**. Uploaded photos can be viewed and downloaded as a zip from **Sessions**. |
| **Sessions** | Shows who scanned what, whether it passed, which rooms still need scanning, and each session's 3D measurement. |
| **History** | Every edit is saved as a version that can be restored. |

**On phones** the tabs move to a bottom bar, room details open in a pull-up sheet, and the plan supports tap to draw, drag to pan and pinch to zoom.

Several people can edit at once. Edits to different rooms merge automatically; if two people change the same room, the app asks whose version to keep.

### Directions

Routes come straight from the floor plan, so a route only works if the plan is connected:

- **Doors join rooms.** A door joins its room to the room on the other side of that wall (within 0.3 m). Draw corridors and lobbies as rooms, and put each room's door on the wall it shares with the corridor.
- **Stairwells join floors.** A **Stairs / lift** room links to the stairwell drawn in the same place on the next floor up. Set it to **Lift** for it to count for step-free routes.
- Routes prefer corridors, lobbies and stairs, and only cut through other rooms when that is much shorter. Inside a room the route goes in straight lines between doors and bends round inside corners.

Indoor GPS is off by 10 to 50 m, which is the size of the whole block, so it can't say which room you're in. The door markers are the precise "you are here": scanning one starts the route at that door.

### Hallways from the shape

The width is measured from the outline itself: every point inside is given its distance to the nearest wall, and the points along the middle of the shape give the typical width (twice that distance). The length is the area divided by the width. A room counts as a **corridor** if it's at most 3.5 m wide and at least 3 times as long as wide, and as a **lobby** if it's over 60 m², under 6 m wide, and fills less than 60% of its bounding box. Anything else stays a room. It's only a guess, so check the type and change it if it's wrong. Rooms you've already given a type are never changed. The thresholds are `HALL` in `web/index.html`.

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
worker/          the 3D measuring worker, run on your own computer (Python); video.py picks frames from a video, walk.py traces corridors, floormap.py maps a floor's rooms, hallways and doors
```

- **Front end:** a single HTML page using Three.js. It checks the server for changes every 4 seconds.
- **Back end:** Vercel functions on Postgres. Six tables (`plan`, `versions`, `sessions`, `photos`, `recon`, `workers`) are created automatically on first use.
- **Photos:** opt-in. The phone resizes each usable photo to 2048 px and re-encodes it, which strips GPS and other EXIF data, then uploads them one at a time. They're stored as JPEG bytes in the `photos` table of the same Neon database, and only served back through `/api/photos`. At about 0.5–1 MB a photo, Neon's free 0.5 GB holds roughly 500–1,000 photos. Each session reserves its number of photos up front; uploads beyond that, or more than 2 hours later, are refused.
- **3D measuring:** a worker on your own computer measures each room from its uploaded photos. See [Measuring rooms from photos](#measuring-rooms-from-photos). It can also trace a corridor and its doors from a walk-through video, or map a whole floor: hallways, rooms and the doors between them. See [Mapping corridors from a walk](#mapping-corridors-from-a-walk) and [Mapping a floor from one walk](#mapping-a-floor-from-one-walk).
- **Saving:** each save includes the version it was based on. If someone else saved first, the server rejects it and the app merges room by room.
- **Who can do what:** everyone can view the plan, get directions and contribute (submit capture sessions and upload their photos). Only editors, who enter `EDIT_KEY` under their name, can draw or change rooms, place the block on the map, import walks or restore versions. Without `EDIT_KEY` set, nobody can edit the shared plan.
- **Safety:** all input is checked field by field before it's stored.
- **No database?** The site still works, saving to each visitor's browser, and shows a banner saying so.

| Route | Purpose |
|-------|---------|
| `GET /api/health` | Is a database connected? Is photo storage set up? Is an edit key needed? |
| `GET /api/state` | Current plan, recent versions and sessions |
| `PUT /api/plan` | Save the plan (editors only: needs `x-edit-key`; returns 409 if someone saved first) |
| `GET /api/versions?rev=N` | Fetch an old version |
| `POST /api/sessions` | Submit a capture session (`photos`: how many it will upload) |
| `POST /api/photos?session=&i=&w=&h=` | Upload one JPEG for a session |
| `GET /api/photos?session=ID` / `?id=ID` | List a session's photos / fetch one (edit key or worker key) |
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
4. Add `EDIT_KEY`, a password you share only with editors. Visitors without it see the finished floor plan and can still contribute photos; editors enter it under **Set your name → Edit key** to draw rooms. It's also needed to view uploaded photos. Without it, the plan can't be edited by anyone.
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
- Offline, on a walk-through video: `python worker.py --video walk.mp4 --plan plan.json`. It uses [ffmpeg](https://ffmpeg.org/download.html) from your PATH, or `--ffmpeg /path/to/ffmpeg`, or else the copy that `pip install -r requirements.txt` bundles. It extracts `--fps` frames per second (default 2), drops frames the app would reject (blurry, too dark, overexposed, blank wall) and frames that repeat the last one, and keeps at most `--max-frames` (default 80, like Live camera), spread evenly. Film slowly at chest height, turn gently at corners and pause on door signs. Phone uploads still go through the app's in-browser capture, which sends only the kept photos instead of the whole video.
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

## Mapping corridors from a walk

Directions needs corridors and doors more than exact room sizes. The worker can trace a corridor from a video of someone walking along it, so nobody has to draw it.

```sh
cd worker && source .venv/bin/activate
python worker.py --walk --video corridor.mp4        # writes walk.json and preview.png
```

Then on the **Floor plan** tab, with no room selected, use **Import walk** under **Walks** and pick `walk.json`.

**How it works**

1. COLMAP works out where each video frame was taken. Frames are matched with their neighbours in the video, which is quicker than matching every pair.
2. You walk on a level floor, so the camera path gives "up". The floor is the densest flat layer of points below the camera.
3. **Scale** comes from the phone being held about 1.45 m above the floor. For a video it's checked against walking pace (about 1.25 m/s). The result says whether the two agree.
4. The path is squared up to the building's main directions and split into straight runs. Each run's two walls are the densest layers of 3D points on either side, which gives the corridor's width. The corridor continues to its end walls when they're visible.
5. **Door signs** like "B-03-02" are read with OCR ([RapidOCR](https://github.com/RapidAI/RapidOCR), on the CPU). Door QR markers are read too, but aren't needed. The line of sight from the camera to the sign is followed to the corridor wall, and where several frames saw the sign, their sight lines are crossed. A door goes there. A code read once right beside a more common one is treated as a misread.
6. Each sign gets a **placeholder room** (up to 4 × 4 m) behind its door. People can fix its shape on the Floor plan, or measure it from photos.

The floor and block come from the signs, or set them with `--floor 3 --block B`. `--no-ocr` reads QR markers only. With `--photos`, a zip of photos in walking order works too, but there's no walking pace to check the scale against.

**Importing.** On an empty floor, the walk is placed at the origin. On a floor that already has rooms, it goes beside them, since the walk isn't lined up with them yet. A sign whose room is already on the plan gets a door on the corridor, but no new room.

**Tested accuracy.** On a rendered L-shaped corridor (24 m and 14 m arms, 2.4 m wide, five door signs on 40 cm plates), a 27-second walk at 2 frames per second gave:
- Corridor area of 81–86 m² against 85.4 m², and widths of 2.35–2.6 m.
- Four of the five signs read. Each door was within 0.1–0.5 m of its sign.
- Phone height and walking pace agreeing on the scale to within 1%.
- After **Import walk**, Directions routed between two of the new rooms, with the right turns.

It hasn't been run on a real corridor yet.

**Filming a corridor**
- Walk slowly, at about normal walking pace, holding the phone at chest height and tilted a little down at the floor.
- Pan gently from side to side, so both walls are filmed.
- Slow down at each door sign, so it's sharp in a few frames.
- Turn slowly at corners. One corridor per video is easiest to check.

---

## Mapping a floor from one walk

Rooms measured one at a time from photos don't line up with each other or with the hallway, so Directions can't get from one to the next. `--map` builds the hallway, the rooms off it and the doors between them from **one** video, so they're placed relative to each other the way they really are.

```sh
cd worker && source .venv/bin/activate
python worker.py --map --video floor.mp4        # writes map.json and preview.png
```

Then on the **Floor plan** tab, with no room selected, use **Import walk or map** under **Walks** and pick `map.json`.

**Or let the website do it all.** On **Capture**, under **Map a whole floor from one video**, turn on the GPS tag, pick the video and press **Upload video for mapping**. Leave a worker running with `python worker.py --server https://your-app.vercel.app --key YOUR_WORKER_KEY`. It:

1. downloads the video from the website. It's kept in the Neon database in 4 MB pieces, since a Vercel function takes at most 4.5 MB per request, so no other storage is needed;
2. maps the floor, as `--map` does;
3. sends the map back, and the website adds it to the floor plan as a new revision (the one before stays in History), without anyone pressing Import;
4. places it by the session's GPS fix: the middle of the walk goes where the GPS says, then it's turned in 90° steps and nudged (within the GPS accuracy, up to 40 m) to fit inside that building's OpenStreetMap outline without covering rooms already on the floor. If two or more rooms on the map match rooms already on the floor by their door signs, it's lined up with those instead. If the block has never been placed on the map, it's placed roughly at the main building first;
5. deletes the video to free database space (set `KEEP_VIDEOS=1` in Vercel to keep it).

Sessions shows each video's progress, and **Show on plan** once it's added. Videos can be up to 400 MB (about 2 minutes at 1080p), since Neon's free tier holds 0.5 GB in all. If the site is behind Vercel Deployment Protection (preview deployments usually are), give the worker the project's **Protection Bypass for Automation** secret with `--bypass SECRET`, or use the production address.

**Filming.** Start a few steps into the hallway. Walk along it, and at each room, slow down by its door sign, walk in through the door, walk once round the room, and come back out the same way. Then carry on down the hallway. Turn slowly. One floor, or one wing of it, per video.

**How it works** (`worker/floormap.py`)

1. COLMAP places every frame in one 3D model, so everything comes out in one frame of reference. Up, the floor and the scale are found as for `--walk`. Video is read at 3 frames a second, since a quick turn at a door can otherwise lose frames and bend the rest of the walk.
2. **Floor space:** every sight line from a camera to a point it saw is marked on a 5 cm grid. Wall points between knee and head height are solid, so a thin wall between a room and the hallway stays a wall. Points above a door's head don't count, so doorways stay open. Points that the other frames see straight through, left by a frame COLMAP placed badly, don't count either.
3. **Doorways** are where the floor space narrows to under 1.1 m. Each wider part is grown from its middle until it meets its neighbours, so neighbouring parts meet in the doorway.
4. Each part's outline is squared up and snapped to its walls. Walls facing each other across a gap under 0.6 m are put on one line, so a room and the hallway share a wall.
5. A **door** goes in each doorway, on the room's side. Long, narrow parts become **Corridor** and big branching open ones **Lobby**, the same rule as **Mark as hallways**.
6. **Door signs** name the room behind the door they're beside. Each sign's sight line is followed to its wall, and the nearest door gets the vote.

**Importing** (by hand, or automatically as above). A room whose sign matches a room already on the plan gets the new outline and doors (the old one stays in History). When two or more rooms match, the map is lined up with them; otherwise it goes beside the other rooms, and **Move** puts it in place. Rooms without a readable sign arrive as `B-04-R1`, `B-04-R2` and so on, the hallway as `B-04-HALL`.

**Tested accuracy.** On a rendered floor (a 20 × 2.4 m hallway with rooms of 5 × 5, 5.85 × 4 and 6 × 5 m off it through 0.9 m doors, 15 cm walls, a door sign at each), an 89-second walk at 3 frames a second gave:
- All 238 frames placed, within 0.10 m of where they were taken (median).
- One hallway and three rooms, with every room wall within 0.18 m and every door within 0.09 m of where it really is. All three signs read and matched to the right room.
- The hallway's first 2.1 m, behind and beside where filming started, was missed. The camera never saw it.
- After **Import walk or map**, Directions routed between all three rooms through the hallway, with the right turns.

At 2 frames a second, the same video lost three frames at one door, and COLMAP put the rest of the walk up to 5 m out, which joined one room to the hallway. It hasn't been run on a real floor yet.

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
