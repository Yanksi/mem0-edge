CREATE TABLE user_aliases (
  user_id TEXT PRIMARY KEY NOT NULL,
  alias TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
