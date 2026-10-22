// Database schema, applied automatically on first use (CREATE ... IF NOT EXISTS).
// Run it by hand with: node -e "import(\"./lib/schema.js\").then(m=>console.log(m.SCHEMA))" | psql "$DATABASE_URL"
export const SCHEMA = `

-- The current floor plan. There is one row (id = 1); rev increases on every save.
CREATE TABLE IF NOT EXISTS plan (
  id      integer PRIMARY KEY CHECK (id = 1),
  rev     integer NOT NULL,
  data    jsonb   NOT NULL,          -- {block, floors[], rooms[]}
  at      timestamptz NOT NULL DEFAULT now(),
  author  text
);

-- Every saved revision of the plan, for History and rollback (README step 13).
CREATE TABLE IF NOT EXISTS versions (
  rev     integer PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  author  text,
  note    text,
  data    jsonb   NOT NULL
);

-- Capture sessions: quality scores and counts. Photos are only kept when the contributor opts in (see photos).
CREATE TABLE IF NOT EXISTS sessions (
  id      bigserial PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  author  text,
  block   text    NOT NULL,
  floor   integer NOT NULL,
  room    text    NOT NULL,
  verdict text    NOT NULL CHECK (verdict IN ('accepted', 'thin', 'rejected')),
  frames  integer NOT NULL,
  usable  integer NOT NULL,
  gaps    integer NOT NULL,
  marker  boolean NOT NULL DEFAULT false,
  detail  jsonb   NOT NULL DEFAULT '{}'   -- {reasons[], tally{}, medians{}, geo?{lat, lng, acc}}
);
CREATE INDEX IF NOT EXISTS sessions_room_idx ON sessions (room);
-- How many photos the contributor chose to upload with the session. Uploads beyond this are refused.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS photo_slots integer NOT NULL DEFAULT 0;

-- 'photos' (checked photos, measured one room at a time) or 'map' (a walk video the worker maps a floor from).
-- A map session's video is uploaded in pieces of up to 4 MB (video_chunks); video_ready is set once all have arrived.
-- After the worker has mapped it, the pieces are deleted to save space (video_deleted_at), unless KEEP_VIDEOS=1.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'photos';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS video_bytes bigint;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS video_type text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS video_parts integer;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS video_ready boolean NOT NULL DEFAULT false;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS video_deleted_at timestamptz;

-- The walk video itself, in order. Like photos, the bytes don't compress, so skip Postgres's compression attempt.
CREATE TABLE IF NOT EXISTS video_chunks (
  session_id bigint  NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  idx        integer NOT NULL,
  data       bytea   NOT NULL,
  PRIMARY KEY (session_id, idx)
);
ALTER TABLE video_chunks ALTER COLUMN data SET STORAGE EXTERNAL;

-- Photos uploaded with a session. A row is claimed before upload, so ref is null until the file is stored.
CREATE TABLE IF NOT EXISTS photos (
  id         bigserial PRIMARY KEY,
  session_id bigint  NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  idx        integer NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  ref        text,                       -- set once the photo is stored ('db')
  bytes      integer NOT NULL,
  w          integer,
  h          integer,
  UNIQUE (session_id, idx)
);
-- The JPEG itself. JPEGs don't compress, so skip Postgres's compression attempt.
ALTER TABLE photos ADD COLUMN IF NOT EXISTS data bytea;
ALTER TABLE photos ALTER COLUMN data SET STORAGE EXTERNAL;
-- Where the photo was taken, {lat, lng, acc}, from the phone's GPS when the session is GPS-tagged (Live camera).
-- Kept here, not in the JPEG (uploads have no EXIF). Used to place the measured room on the plan.
ALTER TABLE photos ADD COLUMN IF NOT EXISTS geo jsonb;

-- Measurements a worker (see worker/) made from a session's photos: outline, height, scale.
CREATE TABLE IF NOT EXISTS recon (
  session_id  bigint PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
  status      text NOT NULL CHECK (status IN ('processing', 'done', 'failed')),
  worker      text,
  claimed_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error       text,
  result      jsonb
);

-- Workers that have checked in recently, so the app can show whether one is running.
CREATE TABLE IF NOT EXISTS workers (
  name    text PRIMARY KEY,
  seen    timestamptz NOT NULL DEFAULT now(),
  version text
);

-- Student accounts. Passwords are stored as scrypt hashes (lib/auth.js).
CREATE TABLE IF NOT EXISTS users (
  id         bigserial PRIMARY KEY,
  email      text NOT NULL UNIQUE,      -- lower case
  student_id text NOT NULL UNIQUE,      -- upper case, e.g. TP012345
  pw_hash    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Logins. Each lasts 6 hours; only the SHA-256 of the browser's token is kept.
CREATE TABLE IF NOT EXISTS logins (
  token_hash text PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS logins_expires_idx ON logins (expires_at);
`;
