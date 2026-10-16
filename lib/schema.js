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

-- Capture sessions. Only quality scores and counts are stored; photos never leave the device.
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
`;
