-- Tags on a task, as a JSON array of lower-case words without the #. NULL or [] when it has none.
ALTER TABLE tasks ADD COLUMN tags TEXT;
