PRAGMA foreign_keys = ON;

CREATE TABLE user (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL, image TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE TABLE session (
  id TEXT PRIMARY KEY, expiresAt TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, ipAddress TEXT, userAgent TEXT,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE
);
CREATE INDEX session_user ON session(userId);
CREATE TABLE account (
  id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  accessToken TEXT, refreshToken TEXT, idToken TEXT,
  accessTokenExpiresAt TEXT, refreshTokenExpiresAt TEXT, scope TEXT, password TEXT,
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE INDEX account_user ON account(userId);
CREATE TABLE verification (
  id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL,
  expiresAt TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE INDEX verification_identifier ON verification(identifier);

CREATE TABLE profiles (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  alias TEXT NOT NULL UNIQUE COLLATE NOCASE,
  total_bytes INTEGER NOT NULL DEFAULT 0 CHECK(total_bytes >= 0)
);
CREATE INDEX profiles_total ON profiles(total_bytes DESC, user_id);
CREATE TABLE limits (
  key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX limits_expiry ON limits(expires_at);
CREATE TABLE budgets (
  key TEXT PRIMARY KEY, bytes INTEGER NOT NULL DEFAULT 0, starts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL, grant_deadline INTEGER NOT NULL,
  stream_deadline INTEGER NOT NULL, redeem_deadline INTEGER NOT NULL,
  max_bytes INTEGER NOT NULL CHECK(max_bytes > 0),
  month_key TEXT NOT NULL, day_key TEXT NOT NULL,
  monthly_limit INTEGER NOT NULL, daily_limit INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'issued' CHECK(state IN ('issued', 'streaming', 'finished')),
  claimed_at INTEGER, finished_at INTEGER
);
CREATE INDEX runs_lease ON runs(user_id, state, stream_deadline);
CREATE INDEX runs_expiry ON runs(redeem_deadline);
CREATE TABLE run_day_highwater (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  day TEXT NOT NULL, credited_bytes INTEGER NOT NULL CHECK(credited_bytes > 0),
  PRIMARY KEY(run_id, day)
);
CREATE TABLE user_day_totals (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  day TEXT NOT NULL, credited_bytes INTEGER NOT NULL CHECK(credited_bytes > 0),
  PRIMARY KEY(user_id, day)
);
CREATE INDEX totals_day ON user_day_totals(day, user_id);

CREATE TRIGGER admit_run BEFORE INSERT ON runs BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM runs WHERE user_id = NEW.user_id AND
    ((state = 'issued' AND grant_deadline > NEW.started_at) OR
     (state = 'streaming' AND stream_deadline > NEW.started_at))
  ) THEN RAISE(ABORT, 'active_run') END;
  SELECT CASE WHEN COALESCE((SELECT bytes FROM budgets WHERE key = NEW.month_key), 0) + NEW.max_bytes > NEW.monthly_limit
    THEN RAISE(ABORT, 'monthly_budget') END;
  SELECT CASE WHEN COALESCE((SELECT bytes FROM budgets WHERE key = NEW.day_key), 0) + NEW.max_bytes > NEW.daily_limit
    THEN RAISE(ABORT, 'daily_budget') END;
  SELECT CASE WHEN COALESCE((SELECT starts FROM budgets WHERE key = NEW.day_key), 0) >= 60
    THEN RAISE(ABORT, 'run_start_limit') END;
  INSERT INTO budgets(key, bytes, starts) VALUES(NEW.month_key, NEW.max_bytes, 1)
    ON CONFLICT(key) DO UPDATE SET bytes = bytes + NEW.max_bytes, starts = starts + 1;
  INSERT INTO budgets(key, bytes, starts) VALUES(NEW.day_key, NEW.max_bytes, 1)
    ON CONFLICT(key) DO UPDATE SET bytes = bytes + NEW.max_bytes, starts = starts + 1;
END;

CREATE TRIGGER credit_first AFTER INSERT ON run_day_highwater BEGIN
  INSERT INTO user_day_totals(user_id, day, credited_bytes)
    SELECT user_id, NEW.day, NEW.credited_bytes FROM runs WHERE id = NEW.run_id
    ON CONFLICT(user_id, day) DO UPDATE SET credited_bytes = credited_bytes + NEW.credited_bytes;
  UPDATE profiles SET total_bytes = total_bytes + NEW.credited_bytes
    WHERE user_id = (SELECT user_id FROM runs WHERE id = NEW.run_id);
END;
CREATE TRIGGER credit_increase AFTER UPDATE OF credited_bytes ON run_day_highwater
WHEN NEW.credited_bytes > OLD.credited_bytes BEGIN
  INSERT INTO user_day_totals(user_id, day, credited_bytes)
    SELECT user_id, NEW.day, NEW.credited_bytes - OLD.credited_bytes FROM runs WHERE id = NEW.run_id
    ON CONFLICT(user_id, day) DO UPDATE SET credited_bytes = credited_bytes + NEW.credited_bytes - OLD.credited_bytes;
  UPDATE profiles SET total_bytes = total_bytes + NEW.credited_bytes - OLD.credited_bytes
    WHERE user_id = (SELECT user_id FROM runs WHERE id = NEW.run_id);
END;
