# Crowdsourced 3D Building Outline with 3DGS

Build a structural 3D outline of a building (walls, floors, doors) with clearly separated, labeled rooms, using photos contributed from ordinary phones.

**Example target:** APU campus. Start with one floor of one block.

> **Key idea:** 3D Gaussian Splatting (3DGS) gives dense, photoreal reconstruction, but it does not produce walls and rooms on its own, and you can't merge splat clouds directly. So the pipeline works in this order:
> 1. Merge everything at the image/pose level.
> 2. Train splats.
> 3. Extract clean geometry and rooms from the result.

---

## Web app

A full-stack web app for the parts of the pipeline that don't need a GPU. The page is [`web/index.html`](web/index.html); the API is in [`api/`](api) and runs as Vercel serverless functions on Postgres.

| Tab | What it does | README steps |
|-----|--------------|--------------|
| Floor plan | Draw rooms (0.5 m grid, right-angle snapping), reshape corners, add doors, set room ID/type/height, colour by type or scan coverage, print QR door markers. Stairwells show treads and an UP/DN arrow | 1, 3, 10–11, 13 |
| 3D outline | Extrudes rooms to ceiling height with wall thickness and door openings, and stacks floors. Stairwells get real stairs (see below). Export GeoJSON, GLB (zipped) and plan JSON | 12, 14 |
| Contribute | Checks photos in the browser (blur by Laplacian variance, exposure, blank wall, overlap between frames), reads door-marker QR codes, then submits the session. Photos never leave the device; only scores and counts are uploaded | 2, 3, 5 |
| Sessions | Contributor sessions, quality verdicts, per-room coverage ("scan these next"), pipeline stage status | 4, 13 |
| History | Every plan edit is a version; restore any one (restoring adds a new version) | 13 |

Registration and 3DGS training (steps 6–8) are shown as "No worker". They need a GPU backend that isn't built yet.

### Stairwells

A room of type **Stairs / lift** is built as a connector between floors (step 12):

- **Switchback** (default): floor landing by the door, a flight up one half, a mid landing, a flight back up the other half, and a balustrade along the well. **Straight**: one flight with a top landing. **Lift shaft**: walls only, with the car on the lowest floor.
- Risers are sized to the storey height (3.6 m gives 22 × 164 mm), with treads up to 300 mm. The inspector shows the numbers and warns when treads, landings or flights are too small.
- Shaft walls run up to the next floor, and the floor slab is left open above the lowest level. If the floor above has no stairwell in the same place, a top landing is drawn.
- **Turn 90°** and **Mirror** change which way the flights run. By default you enter through the first door and climb away from it.
- The stair geometry fills the room's bounding rectangle, so draw stairwells as rectangles. Stairwells on consecutive floors should share the same outline.
- GeoJSON exports include `stair_kind`, `connects_to_floor`, `risers`, `riser_m`, `tread_m` and `flight_width_m`.

### Backend

| Route | Purpose |
|-------|---------|
| `GET /api/health` | Is a database connected, and is an edit key required? |
| `GET /api/state` | Current plan, the latest 60 versions and 300 sessions. Supports `If-None-Match` (the app polls every 4 s) |
| `PUT /api/plan` | Save the whole plan as a new revision. Sends `baseRev`; returns **409** with the current plan if someone else saved first |
| `GET /api/versions?rev=N` | One saved revision, for restore. The latest 200 are kept |
| `POST /api/sessions` | Submit a capture session (scores and counts only) |

- **Concurrent edits:** on a 409 the app merges room by room against the version it last loaded. Edits to different rooms merge automatically. If two people changed the same room, a banner asks whether to keep your version or load theirs.
- **Validation:** every request is rebuilt from known fields with limits on sizes and counts (`lib/validate.js`), and queries are parameterised.
- **Identity:** there are no accounts. Contributors type a display name, which is saved in their browser.
- **Optional edit key:** set `EDIT_KEY`, and writes then need that key. Without it, anyone with the link can view the plan.
- **Schema:** the tables are created on first use (`lib/schema.js`): `plan` (one row), `versions` and `sessions`.

### Deploy on Vercel

The repo is connected to Vercel, so every push deploys. `vercel.json` runs `scripts/build-vercel.sh`, which wraps `web/index.html` in a full HTML document in `dist/`, and Vercel deploys `api/*.js` as functions.

1. **Add a database:** in the Vercel project, open **Storage** → **Create Database** → **Neon (Postgres)** and connect it to the project. This sets `DATABASE_URL`. Any Postgres works if you set `DATABASE_URL` (or `POSTGRES_URL`) yourself. For providers whose TLS certificate isn't publicly trusted, also set `PGSSL_NO_VERIFY=1`.
2. **Optionally set `EDIT_KEY`** under **Settings** → **Environment Variables**.
3. **Redeploy** so the functions pick up the variables.

Until a database is connected, the site still works as a standalone copy: a banner says so, and the plan, history and sessions are saved in each visitor's browser.

### Run locally

```sh
npm install
DATABASE_URL=postgres://user:pass@localhost/apu npm run dev   # http://localhost:3000
TEST_DATABASE_URL=postgres://user:pass@localhost/apu_test npm test   # wipes that database's tables
```

Without `TEST_DATABASE_URL`, `npm test` runs only the validation tests.

The same page also runs as a claude.ai artifact, where it uses the artifact's shared storage instead of the API: https://claude.ai/artifact/EWr8GzRBKErHG9igFdL71C (private until shared from the page's Share menu).

---

## Architecture at a glance

```
App (AR capture + markers) -> upload
 -> blur faces + mask people -> quality check
 -> localize into global frame (hloc + markers + pose graph)
 -> per-block 2DGS/PGSR training (depth-supervised)
 -> depth fusion -> mesh/points -> planes -> floor plan -> rooms -> labels
 -> PostGIS + GLB (outline) + SPZ (splat blocks)
 -> viewer + admin editor
```

---

## Pipeline

### Part A: Capture and data intake

#### 1. Define the classes and scope
- **Element classes:** wall, floor, ceiling, door, window, stairs, lift, column.
- **Room classes:** lecture hall, lab, corridor, toilet, lobby, office. Each room gets a unique ID (e.g. `03-12`).
- Start with **one floor of one block**.

*Why:* element classes come from geometry, while room classes come from layout and signs. The two are separate problems.

#### 2. Get permission and plan for privacy
- Get written approval from the campus before scanning.
- Add a consent screen, a delete-my-data option and rules for restricted areas (PDPA in Malaysia).
- Keep only what you need. Consider deleting raw photos after processing.

*Why:* a splat looks like the real place, so it carries more privacy risk than a point cloud.

#### 3. Capture inside your own app (not the gallery)
- Record each frame with its **ARKit / ARCore pose**, camera intrinsics, timestamp and gravity direction.
- Show live guidance such as "too blurry", "move slower" and "cover this wall".
- Print a **QR code / AprilTag** for each room door and stairwell. The code holds the room ID, floor and block.

*Why:* plain photos carry no scale, pose or "up" direction. AR capture gives metric scale and good starting poses. Markers give fixed anchors and room labels you can trust.

#### 4. Upload sessions to a backend queue
- Upload each "session" (frames + metadata) in the background over Wi-Fi.
- Keep files in object storage, track them in PostgreSQL/PostGIS and process them with a job queue.

**Tools:** FastAPI, S3-compatible storage, Celery/Redis, PostGIS

*Why:* reconstruction is slow and needs a GPU, so it has to run asynchronously on workers.

#### 5. Privacy filter and quality check
- Blur faces and licence plates, and strip personal EXIF data.
- **Mask out people and moving objects** (SAM / YOLO) and leave those pixels out of training.
- Reject bad sessions: blurry (Laplacian variance), too few frames, low overlap, too dark, or mostly blank wall. Tell the user why a session was rejected.

*Why:* blur before training, never after. A splat bakes in everything it sees, including ghost people.

### Part B: Merge everything into one frame

#### 6. Register every session into one building coordinate system
- Use image retrieval (NetVLAD / MegaLoc) to find where a new session belongs.
- Localize it with **hloc** (SuperPoint + LightGlue), or with COLMAP / GLOMAP. Use VGGT / MASt3R where blank walls break matching.
- Fall back on markers as fixed anchors when visual matching fails.
- Refine all poses with global bundle adjustment / pose graph optimization (GTSAM, g2o).

*Why:* two splat models can't be merged. Merge the *images and poses* instead, so all photos share one frame before any training starts.

### Part C: 3D Gaussian Splatting

#### 7. Train splats in blocks (per floor / area)
- Split the building into blocks, such as a room or a corridor segment. Train each block on the images that see it.
- Use a **geometry-friendly variant**: 2DGS, PGSR, Gaussian Opacity Fields, RaDe-GS or MILo.
- Add **depth supervision** (AR depth, or Depth Anything scaled to metric).
- Add **per-camera appearance/exposure correction** and training that ignores distractors (SpotLessSplats).

**Engines:** gsplat, Nerfstudio splatfacto. **Large scenes:** Hierarchical 3DGS, CityGaussian, Octree-GS.

*Why:* one giant model won't fit in memory, and blocks let you retrain only what changed. Depth and appearance fixes reduce floaters on blank walls and even out differences between phone cameras.

#### 8. Extract real geometry from the splats
- Render depth maps from many virtual viewpoints.
- Fuse them into a mesh or point cloud with **TSDF fusion** (Open3D), or use the variant's built-in mesh extraction.

*Why:* you need accurate surface positions, not just something that looks right from a camera.

### Part D: Structure and rooms

#### 9. Detect walls, floor and ceiling, and build the floor plan
- Align to gravity (floor normal = Z axis). Check scale against a known door height (~2.1 m).
- **RANSAC plane fitting** (Open3D): vertical planes are walls, the lowest large horizontal plane is the floor and the highest is the ceiling.
- Slice at about 1.5 m, project top-down, fit lines, snap them to right angles and close gaps.
- Optional: 3D segmentation (Mask3D, Point Transformer V3) for doors, windows and stairs.

*Why:* this turns a blob of points into building structure. Start with RANSAC because it's the easiest to debug.

#### 10. Separate each room
1. Find doorways as gaps in the walls.
2. Draw a virtual line across each doorway to close it.
3. Run **connected components** or **watershed** on the free floor space.
4. Each enclosed region becomes one room polygon, and the corridor is its own region. Give each one a unique ID.

**Tools:** OpenCV, Shapely, scikit-image

*Why:* a room is a space enclosed by walls and connected to others by doors. This step is what clearly separates one room from the next.

#### 11. Label the room types
- **First choice:** the QR/AprilTag at the door (most reliable).
- **Second choice:** OCR on door signs (PaddleOCR / EasyOCR).
- **Fallback:** a classifier (rows of seats suggest a lecture hall; many desks and PCs suggest a lab).
- **Optional:** semantic Gaussians (Gaussian Grouping, LangSplat) can help classify elements, with the results snapped to your clean geometry. These methods are still research-grade, so use them only as a helper.
- Rooms that end up unlabeled go to a human review queue.

#### 12. Extrude the 3D outline and stack floors
- Extrude each room polygon to ceiling height, add wall thickness and cut openings for doors and windows.
- Store attributes per room: `id`, `type`, `floor`, `area`.
- Scan stairwells and lifts as connectors, align floors using the markers there and stack floors at their true heights.

*Why:* drift between floors is the main technical risk, so the stairwell markers act as anchors.

### Part E: Trust, output and viewer

#### 13. Human-in-the-loop editor and moderation
- Provide a web editor for fixing walls, renaming rooms and merging or splitting polygons. Version every change so it can be rolled back.
- Require contributor accounts (e.g. campus email login).
- Score confidence per area by how many independent sessions agree, and flag sessions that strongly disagree.
- Show a heat map of unscanned areas to guide contributors.

*Why:* the pipeline will make mistakes, especially on glass walls and plain corridors. Manual correction with rollback keeps crowdsourced data trustworthy.

#### 14. Export and show two layers
- **Outline layer:** colour-coded, selectable room polygons and walls, exported as GLB (3D) and GeoJSON (2D), plus DXF or IFC if you need CAD/BIM.
- **Splat layer (toggle):** compress with SPZ / SOGS / SuperSplat, render with Spark or gsplat.js on Three.js and stream it per block.

*Why:* users get a realistic "look inside" mode while the structural model stays accurate and lightweight.

---

## Suggested build order

| Phase | Goal |
|-------|------|
| 1 | One room, your own phone: AR capture, train 2DGS, extract a mesh, get one clean room polygon. |
| 2 | One floor, several contributors: global registration, blocks, floor plan and room splitting. |
| 3 | Appearance correction, depth supervision, masks, privacy filter, admin editor. |
| 4 | Semantic Gaussians, splat viewer layer, more floors and blocks, public launch. |

---

## What 3DGS costs you

- **Compute:** training needs a GPU. Retrain block by block on cloud GPUs.
- **Updates:** a new photo means retraining its block, which is slower than updating a point cloud.
- **Storage/bandwidth:** splat files are big, so compress and stream them.
- **Failure modes:** blank walls, glass, mirrors and shiny floors cause floaters and false depth.
- **Older phones** without ARCore/ARKit can't take part.

> **If you only need the outline, splats are optional.** Build steps 1–6 and 9–14 first (skipping 7–8), then add 3DGS later as a viewing layer.
