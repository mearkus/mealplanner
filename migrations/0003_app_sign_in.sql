-- Sign-in from the Android/iOS apps: the app opens Google sign-in in the phone's browser, the server
-- finishes it and hands the app a one-time code, which the app exchanges (with its secret) for a token.
CREATE TABLE auth_requests (
  id TEXT PRIMARY KEY,                -- random value passed to Google as "state"
  challenge TEXT NOT NULL,            -- SHA-256 (base64url) of a secret only the app knows
  invite_code TEXT,
  family_name TEXT,
  app_code TEXT UNIQUE,               -- one-time code returned to the app after sign-in
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now'))
)
