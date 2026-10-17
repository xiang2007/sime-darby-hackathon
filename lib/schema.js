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
  detail  jsonb   NOT NULL DEFAULT '{}'   -- {reasons[], tally{}, medians{}}
);
CREATE INDEX IF NOT EXISTS sessions_room_idx ON sessions (room);
-- How many photos the contributor chose to upload with the session. Uploads beyond this are refused.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS photo_slots integer NOT NULL DEFAULT 0;

-- Photos uploaded with a session. A row is claimed before upload, so ref is null until the file is stored.
CREATE TABLE IF NOT EXISTS photos (
  id         bigserial PRIMARY KEY,
  session_id bigint  NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  idx        integer NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  ref        text,                       -- Blob URL, or local:<path> in dev
  bytes      integer NOT NULL,
  w          integer,
  h          integer,
  UNIQUE (session_id, idx)
);
`;
