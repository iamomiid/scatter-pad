-- One row per tag: its colour on the page and a description that tells the auto-tagger what belongs under it.
CREATE TABLE tags (
  name        TEXT PRIMARY KEY,           -- lower case, without the #
  color       INTEGER NOT NULL,           -- 0..7, one of the page's tag colours
  description TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,           -- ms since epoch
  updated_at  INTEGER NOT NULL            -- ms since epoch
);
