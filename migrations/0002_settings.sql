-- Page preferences, one row per setting. The value is JSON.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,   -- e.g. auto_sweep
  value      TEXT NOT NULL,      -- JSON
  updated_at INTEGER NOT NULL    -- ms since epoch
);
