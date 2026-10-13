-- One row per task. Rows are never deleted: removing or sweeping a task sets archived_at.
CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,            -- random id made in the browser
  text        TEXT NOT NULL,               -- the two-to-five-word summary
  x           REAL NOT NULL,               -- centre of the task, 0..1 of the page width
  y           REAL NOT NULL,               -- centre of the task, 0..1 of the page height
  tilt        REAL NOT NULL DEFAULT 0,     -- handwritten rotation, degrees
  done        INTEGER NOT NULL DEFAULT 0,  -- 1 when crossed off
  created_at  INTEGER NOT NULL,            -- ms since epoch
  done_at     INTEGER,                     -- ms since epoch, NULL while open
  updated_at  INTEGER NOT NULL,            -- ms since epoch, set by the Worker on every write
  archived_at INTEGER                      -- ms since epoch, NULL while the task is on the page
);

CREATE INDEX tasks_on_page ON tasks (created_at) WHERE archived_at IS NULL;
