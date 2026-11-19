-- Stone & Crown online: schema (safe to run repeatedly; also applied automatically at server start)
CREATE TABLE IF NOT EXISTS players (
  pid         TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL,                 -- sha256 of the secret session token kept in the player's browser
  name        TEXT NOT NULL,
  avatar      TEXT,                          -- id of the troop used as profile picture
  squad       JSONB NOT NULL DEFAULT '[]',   -- the player's selected troop ids
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS players_name_idx ON players (lower(name));

-- Friends system structure (friend requests are stored now; room invitations come later)
CREATE TABLE IF NOT EXISTS friendships (
  player_a   TEXT NOT NULL REFERENCES players(pid) ON DELETE CASCADE,
  player_b   TEXT NOT NULL REFERENCES players(pid) ON DELETE CASCADE,
  requester  TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_a, player_b)
);

CREATE TABLE IF NOT EXISTS matches (
  id          BIGSERIAL PRIMARY KEY,
  room_code   TEXT NOT NULL,
  map_id      TEXT NOT NULL,
  mode        TEXT NOT NULL,
  difficulty  TEXT NOT NULL,
  victory     BOOLEAN NOT NULL,
  wave        INT NOT NULL,
  players     JSONB NOT NULL,
  duration_s  INT NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
