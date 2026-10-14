-- The page lays tasks out in rows, in this order. NULL falls back to created_at.
ALTER TABLE tasks ADD COLUMN sort REAL;
