package store

import (
	"database/sql"
	"strings"
)

// Backfill + trigger enforcement for the strict-constraint migration.
//
// Fresh databases get CHECKs from the CREATE TABLE statements. Existing
// databases already have tables without those CHECKs (SQLite cannot ADD a
// CHECK to a live table), so this file does two things on every open:
//  1. backfills legacy sentinel empties to real values (`''` -> `local`,
//     missing opponent names, `''` display names, upper-case Lichess names);
//  2. installs BEFORE INSERT/UPDATE triggers that reject the same invalid
//     rows the fresh-table CHECKs reject, so old and new databases behave
//     identically going forward.
//
// Trigger messages mirror the Go validation codes so failures read clearly
// in logs and tests.

func ensureStrictConstraints(db *sql.DB) error {
	if err := backfillLegacyRows(db); err != nil {
		return err
	}
	return ensureDbTriggers(db)
}

func backfillLegacyRows(db *sql.DB) error {
	// Display names: empty becomes the documented fallback.
	if _, err := db.Exec(`UPDATE users SET display_name = 'Player' WHERE display_name = ''`); err != nil {
		return err
	}
	// Over-long display names predate the 40-char cap: trim them.
	if _, err := db.Exec(`UPDATE users SET display_name = substr(display_name, 1, 40) WHERE length(display_name) > 40`); err != nil {
		return err
	}
	// Lichess linkage: empty strings become NULL (UNIQUE allows many NULLs,
	// but '' would collide and fail the length CHECK).
	if _, err := db.Exec(`UPDATE users SET lichess_username = NULL WHERE lichess_username = ''`); err != nil {
		return err
	}
	if _, err := db.Exec(`UPDATE users SET lichess_id = NULL WHERE lichess_id = ''`); err != nil {
		return err
	}
	// Canonical lowercase for the dedupe column; display_name keeps case.
	if _, err := db.Exec(`UPDATE users SET lichess_username = lower(lichess_username) WHERE lichess_username IS NOT NULL AND lichess_username <> lower(lichess_username)`); err != nil {
		return err
	}
	// Games: lichess rows missing a name predate name stamping. 'Unknown'
	// is the ADD COLUMN default for pre-migration tables; treat it like ''.
	if _, err := db.Exec(`UPDATE games SET opponent = 'Lichess' WHERE (opponent IS NULL OR opponent = '' OR opponent = 'Unknown') AND source LIKE 'lichess:%'`); err != nil {
		return err
	}
	// Games: local rows missing a name get the engine stamp.
	if _, err := db.Exec(`UPDATE games SET opponent = 'Maia ' || elo_maia WHERE (opponent IS NULL OR opponent = '' OR opponent = 'Unknown')`); err != nil {
		return err
	}
	// Games: empty source means a local engine game.
	if _, err := db.Exec(`UPDATE games SET source = 'local' WHERE source IS NULL OR source = ''`); err != nil {
		return err
	}
	return nil
}

// normalizeLichessUsername canonicalizes a Lichess username for storage and
// lookup: trim surrounding space, lowercase. Lichess names are
// case-insensitive for identity; display case lives in display_name.
func normalizeLichessUsername(username string) string {
	return strings.ToLower(strings.TrimSpace(username))
}

// ValidateDisplayName checks a local display name before it reaches the store.
func ValidateDisplayName(name string) error {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return nil // callers map empty to the 'Player' fallback
	}
	if len([]rune(trimmed)) < 1 || len([]rune(trimmed)) > 40 {
		return ErrInvalidDisplayName
	}
	for _, c := range trimmed {
		if c < 0x20 || c == 0x7f {
			return ErrInvalidDisplayName
		}
	}
	return nil
}

func ensureDbTriggers(db *sql.DB) error {
	triggers := []string{
		// Games: every column a handler can stamp.
		`CREATE TRIGGER IF NOT EXISTS trg_games_insert BEFORE INSERT ON games BEGIN
			SELECT CASE WHEN NEW.id IS NULL OR length(NEW.id) < 1 OR length(NEW.id) > 128 THEN RAISE(ABORT, 'games id must be 1-128 chars') END;
			SELECT CASE WHEN NEW.created_at IS NULL OR length(NEW.created_at) < 1 OR length(NEW.created_at) > 64 THEN RAISE(ABORT, 'games created_at must be non-empty') END;
			SELECT CASE WHEN NEW.updated_at IS NULL OR length(NEW.updated_at) < 1 OR length(NEW.updated_at) > 64 OR NEW.updated_at < NEW.created_at THEN RAISE(ABORT, 'games updated_at must be non-empty and >= created_at') END;
			SELECT CASE WHEN NEW.user_color NOT IN ('white', 'black') THEN RAISE(ABORT, 'games user_color must be white or black') END;
			SELECT CASE WHEN NEW.elo_maia IS NULL OR NEW.elo_maia < 0 OR NEW.elo_maia > 5000 THEN RAISE(ABORT, 'games elo_maia must be between 0 and 5000') END;
			SELECT CASE WHEN NEW.elo_user IS NULL OR NEW.elo_user < 0 OR NEW.elo_user > 5000 THEN RAISE(ABORT, 'games elo_user must be between 0 and 5000') END;
			SELECT CASE WHEN NEW.model NOT IN ('79m', '5m') THEN RAISE(ABORT, 'games model must be lowercase 79m or 5m') END;
			SELECT CASE WHEN NEW.moves IS NULL OR NOT json_valid(NEW.moves) THEN RAISE(ABORT, 'games moves must be JSON') END;
			SELECT CASE WHEN NEW.result NOT IN ('', 'resigned') THEN RAISE(ABORT, 'games result must be empty or resigned') END;
			SELECT CASE WHEN NEW.temperature IS NULL OR NEW.temperature < 0 OR NEW.temperature > 2 THEN RAISE(ABORT, 'games temperature must be between 0 and 2') END;
			SELECT CASE WHEN NEW.rating_diff IS NOT NULL AND (NEW.rating_diff < -1000 OR NEW.rating_diff > 1000) THEN RAISE(ABORT, 'games rating_diff must be between -1000 and 1000') END;
			SELECT CASE WHEN NEW.time_control IS NOT NULL AND (length(NEW.time_control) < 1 OR length(NEW.time_control) > 32) THEN RAISE(ABORT, 'games time_control must be 1-32 chars') END;
			SELECT CASE WHEN NEW.speed IS NOT NULL AND NEW.speed NOT IN ('ultrabullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence', 'unlimited') THEN RAISE(ABORT, 'games speed must be a Lichess pool') END;
			SELECT CASE WHEN NEW.clocks IS NOT NULL AND NOT json_valid(NEW.clocks) THEN RAISE(ABORT, 'games clocks must be JSON') END;
			SELECT CASE WHEN NEW.source IS NULL OR length(NEW.source) < 1 OR length(NEW.source) > 32 OR (NEW.source <> 'local' AND (NEW.source NOT LIKE 'lichess:%' OR length(NEW.source) < 12 OR length(NEW.source) > 24)) THEN RAISE(ABORT, 'games source must be local or lichess:<gameId>') END;
			SELECT CASE WHEN NEW.opponent IS NULL OR length(NEW.opponent) < 1 OR length(NEW.opponent) > 64 OR length(trim(NEW.opponent)) < 1 THEN RAISE(ABORT, 'games opponent must be 1-64 printable characters') END;
			SELECT CASE WHEN NEW.owner_id IS NULL THEN RAISE(ABORT, 'games owner_id must be non-null (empty means unowned)') END;
			SELECT CASE WHEN NEW.owner_id <> '' AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.owner_id) THEN RAISE(ABORT, 'games owner_id must reference users(id)') END;
		END`,
		`CREATE TRIGGER IF NOT EXISTS trg_games_update BEFORE UPDATE ON games BEGIN
			SELECT CASE WHEN NEW.id IS NULL OR length(NEW.id) < 1 OR length(NEW.id) > 128 THEN RAISE(ABORT, 'games id must be 1-128 chars') END;
			SELECT CASE WHEN NEW.created_at IS NULL OR length(NEW.created_at) < 1 OR length(NEW.created_at) > 64 THEN RAISE(ABORT, 'games created_at must be non-empty') END;
			SELECT CASE WHEN NEW.updated_at IS NULL OR length(NEW.updated_at) < 1 OR length(NEW.updated_at) > 64 OR NEW.updated_at < NEW.created_at THEN RAISE(ABORT, 'games updated_at must be non-empty and >= created_at') END;
			SELECT CASE WHEN NEW.user_color NOT IN ('white', 'black') THEN RAISE(ABORT, 'games user_color must be white or black') END;
			SELECT CASE WHEN NEW.elo_maia IS NULL OR NEW.elo_maia < 0 OR NEW.elo_maia > 5000 THEN RAISE(ABORT, 'games elo_maia must be between 0 and 5000') END;
			SELECT CASE WHEN NEW.elo_user IS NULL OR NEW.elo_user < 0 OR NEW.elo_user > 5000 THEN RAISE(ABORT, 'games elo_user must be between 0 and 5000') END;
			SELECT CASE WHEN NEW.model NOT IN ('79m', '5m') THEN RAISE(ABORT, 'games model must be lowercase 79m or 5m') END;
			SELECT CASE WHEN NEW.moves IS NULL OR NOT json_valid(NEW.moves) THEN RAISE(ABORT, 'games moves must be JSON') END;
			SELECT CASE WHEN NEW.result NOT IN ('', 'resigned') THEN RAISE(ABORT, 'games result must be empty or resigned') END;
			SELECT CASE WHEN NEW.temperature IS NULL OR NEW.temperature < 0 OR NEW.temperature > 2 THEN RAISE(ABORT, 'games temperature must be between 0 and 2') END;
			SELECT CASE WHEN NEW.rating_diff IS NOT NULL AND (NEW.rating_diff < -1000 OR NEW.rating_diff > 1000) THEN RAISE(ABORT, 'games rating_diff must be between -1000 and 1000') END;
			SELECT CASE WHEN NEW.time_control IS NOT NULL AND (length(NEW.time_control) < 1 OR length(NEW.time_control) > 32) THEN RAISE(ABORT, 'games time_control must be 1-32 chars') END;
			SELECT CASE WHEN NEW.speed IS NOT NULL AND NEW.speed NOT IN ('ultrabullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence', 'unlimited') THEN RAISE(ABORT, 'games speed must be a Lichess pool') END;
			SELECT CASE WHEN NEW.clocks IS NOT NULL AND NOT json_valid(NEW.clocks) THEN RAISE(ABORT, 'games clocks must be JSON') END;
			SELECT CASE WHEN NEW.source IS NULL OR length(NEW.source) < 1 OR length(NEW.source) > 32 OR (NEW.source <> 'local' AND (NEW.source NOT LIKE 'lichess:%' OR length(NEW.source) < 12 OR length(NEW.source) > 24)) THEN RAISE(ABORT, 'games source must be local or lichess:<gameId>') END;
			SELECT CASE WHEN NEW.opponent IS NULL OR length(NEW.opponent) < 1 OR length(NEW.opponent) > 64 OR length(trim(NEW.opponent)) < 1 THEN RAISE(ABORT, 'games opponent must be 1-64 printable characters') END;
			SELECT CASE WHEN NEW.owner_id IS NULL THEN RAISE(ABORT, 'games owner_id must be non-null (empty means unowned)') END;
			SELECT CASE WHEN NEW.owner_id <> '' AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.owner_id) THEN RAISE(ABORT, 'games owner_id must reference users(id)') END;
		END`,
		// Deleting a game clears per-user markers pointing at it (CASCADE).
		`CREATE TRIGGER IF NOT EXISTS trg_games_delete_current AFTER DELETE ON games BEGIN
			DELETE FROM user_current WHERE game_id = OLD.id;
		END`,
		// Users: display name + paired, lowercase Lichess linkage.
		`CREATE TRIGGER IF NOT EXISTS trg_users_insert BEFORE INSERT ON users BEGIN
			SELECT CASE WHEN NEW.id IS NULL OR length(NEW.id) < 1 OR length(NEW.id) > 128 THEN RAISE(ABORT, 'users id must be 1-128 chars') END;
			SELECT CASE WHEN NEW.created_at IS NULL OR length(NEW.created_at) < 1 THEN RAISE(ABORT, 'users created_at must be non-empty') END;
			SELECT CASE WHEN NEW.display_name IS NULL OR length(NEW.display_name) < 1 OR length(NEW.display_name) > 40 THEN RAISE(ABORT, 'users display_name must be 1-40 chars') END;
			SELECT CASE WHEN NEW.lichess_username IS NOT NULL AND (length(NEW.lichess_username) < 1 OR length(NEW.lichess_username) > 64 OR NEW.lichess_username <> lower(NEW.lichess_username)) THEN RAISE(ABORT, 'users lichess_username must be 1-64 lowercase chars') END;
			SELECT CASE WHEN NEW.lichess_id IS NOT NULL AND length(NEW.lichess_id) < 1 THEN RAISE(ABORT, 'users lichess_id must be non-empty') END;
			SELECT CASE WHEN (NEW.lichess_username IS NULL) <> (NEW.lichess_id IS NULL) THEN RAISE(ABORT, 'users lichess_username and lichess_id must both be null or both set') END;
		END`,
		`CREATE TRIGGER IF NOT EXISTS trg_users_update BEFORE UPDATE ON users BEGIN
			SELECT CASE WHEN NEW.id IS NULL OR length(NEW.id) < 1 OR length(NEW.id) > 128 THEN RAISE(ABORT, 'users id must be 1-128 chars') END;
			SELECT CASE WHEN NEW.created_at IS NULL OR length(NEW.created_at) < 1 THEN RAISE(ABORT, 'users created_at must be non-empty') END;
			SELECT CASE WHEN NEW.display_name IS NULL OR length(NEW.display_name) < 1 OR length(NEW.display_name) > 40 THEN RAISE(ABORT, 'users display_name must be 1-40 chars') END;
			SELECT CASE WHEN NEW.lichess_username IS NOT NULL AND (length(NEW.lichess_username) < 1 OR length(NEW.lichess_username) > 64 OR NEW.lichess_username <> lower(NEW.lichess_username)) THEN RAISE(ABORT, 'users lichess_username must be 1-64 lowercase chars') END;
			SELECT CASE WHEN NEW.lichess_id IS NOT NULL AND length(NEW.lichess_id) < 1 THEN RAISE(ABORT, 'users lichess_id must be non-empty') END;
			SELECT CASE WHEN (NEW.lichess_username IS NULL) <> (NEW.lichess_id IS NULL) THEN RAISE(ABORT, 'users lichess_username and lichess_id must both be null or both set') END;
		END`,
		// Sessions: bearer ids + non-empty timestamps (expired rows are
		// allowed: expiry is enforced on read, and tests mint expired rows).
		`CREATE TRIGGER IF NOT EXISTS trg_sessions_insert BEFORE INSERT ON sessions BEGIN
			SELECT CASE WHEN NEW.id IS NULL OR length(NEW.id) < 1 THEN RAISE(ABORT, 'sessions id must be non-empty') END;
			SELECT CASE WHEN NEW.user_id IS NULL OR length(NEW.user_id) < 1 THEN RAISE(ABORT, 'sessions user_id must be non-empty') END;
			SELECT CASE WHEN NEW.created_at IS NULL OR length(NEW.created_at) < 1 THEN RAISE(ABORT, 'sessions created_at must be non-empty') END;
			SELECT CASE WHEN NEW.expires_at IS NULL OR length(NEW.expires_at) < 1 THEN RAISE(ABORT, 'sessions expires_at must be non-empty') END;
		END`,
		`CREATE TRIGGER IF NOT EXISTS trg_sessions_update BEFORE UPDATE ON sessions BEGIN
			SELECT CASE WHEN NEW.id IS NULL OR length(NEW.id) < 1 THEN RAISE(ABORT, 'sessions id must be non-empty') END;
			SELECT CASE WHEN NEW.user_id IS NULL OR length(NEW.user_id) < 1 THEN RAISE(ABORT, 'sessions user_id must be non-empty') END;
			SELECT CASE WHEN NEW.created_at IS NULL OR length(NEW.created_at) < 1 THEN RAISE(ABORT, 'sessions created_at must be non-empty') END;
			SELECT CASE WHEN NEW.expires_at IS NULL OR length(NEW.expires_at) < 1 THEN RAISE(ABORT, 'sessions expires_at must be non-empty') END;
		END`,
		// Current-game markers: the game must exist (plus the FK for new DBs).
		`CREATE TRIGGER IF NOT EXISTS trg_user_current_insert BEFORE INSERT ON user_current BEGIN
			SELECT CASE WHEN NEW.user_id IS NULL OR length(NEW.user_id) < 1 THEN RAISE(ABORT, 'user_current user_id must be non-empty') END;
			SELECT CASE WHEN NEW.game_id IS NULL OR length(NEW.game_id) < 1 THEN RAISE(ABORT, 'user_current game_id must be non-empty') END;
			SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM games WHERE id = NEW.game_id) THEN RAISE(ABORT, 'user_current game_id must reference games(id)') END;
		END`,
		`CREATE TRIGGER IF NOT EXISTS trg_user_current_update BEFORE UPDATE ON user_current BEGIN
			SELECT CASE WHEN NEW.user_id IS NULL OR length(NEW.user_id) < 1 THEN RAISE(ABORT, 'user_current user_id must be non-empty') END;
			SELECT CASE WHEN NEW.game_id IS NULL OR length(NEW.game_id) < 1 THEN RAISE(ABORT, 'user_current game_id must be non-empty') END;
			SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM games WHERE id = NEW.game_id) THEN RAISE(ABORT, 'user_current game_id must reference games(id)') END;
		END`,
		// OAuth state: PK + non-empty fields (expiry enforced on consume).
		`CREATE TRIGGER IF NOT EXISTS trg_oauth_state_insert BEFORE INSERT ON oauth_state BEGIN
			SELECT CASE WHEN NEW.state IS NULL OR length(NEW.state) < 1 THEN RAISE(ABORT, 'oauth_state state must be non-empty') END;
			SELECT CASE WHEN NEW.verifier IS NULL OR length(NEW.verifier) < 1 THEN RAISE(ABORT, 'oauth_state verifier must be non-empty') END;
			SELECT CASE WHEN NEW.redirect_uri IS NULL OR length(NEW.redirect_uri) < 1 THEN RAISE(ABORT, 'oauth_state redirect_uri must be non-empty') END;
			SELECT CASE WHEN NEW.expires_at IS NULL OR length(NEW.expires_at) < 1 THEN RAISE(ABORT, 'oauth_state expires_at must be non-empty') END;
		END`,
		// Import runs: provider vocabulary + non-negative counters. Username
		// may be empty (older clients omit it); cap length only.
		`CREATE TRIGGER IF NOT EXISTS trg_import_runs_insert BEFORE INSERT ON import_runs BEGIN
			SELECT CASE WHEN NEW.id IS NULL OR length(NEW.id) < 1 THEN RAISE(ABORT, 'import_runs id must be non-empty') END;
			SELECT CASE WHEN NEW.provider NOT IN ('lichess') THEN RAISE(ABORT, 'import_runs provider must be lichess') END;
			SELECT CASE WHEN NEW.username IS NULL OR length(NEW.username) > 64 THEN RAISE(ABORT, 'import_runs username must be 0-64 chars') END;
			SELECT CASE WHEN NEW.requested IS NULL OR NEW.requested < 0 THEN RAISE(ABORT, 'import_runs requested must be >= 0') END;
			SELECT CASE WHEN NEW.saved IS NULL OR NEW.saved < 0 OR NEW.saved > NEW.requested THEN RAISE(ABORT, 'import_runs saved must be 0..requested') END;
			SELECT CASE WHEN NEW.skipped IS NULL OR NEW.skipped < 0 OR NEW.skipped > NEW.requested THEN RAISE(ABORT, 'import_runs skipped must be 0..requested') END;
		END`,
		`CREATE TRIGGER IF NOT EXISTS trg_import_runs_update BEFORE UPDATE ON import_runs BEGIN
			SELECT CASE WHEN NEW.id IS NULL OR length(NEW.id) < 1 THEN RAISE(ABORT, 'import_runs id must be non-empty') END;
			SELECT CASE WHEN NEW.provider NOT IN ('lichess') THEN RAISE(ABORT, 'import_runs provider must be lichess') END;
			SELECT CASE WHEN NEW.username IS NULL OR length(NEW.username) > 64 THEN RAISE(ABORT, 'import_runs username must be 0-64 chars') END;
			SELECT CASE WHEN NEW.requested IS NULL OR NEW.requested < 0 THEN RAISE(ABORT, 'import_runs requested must be >= 0') END;
			SELECT CASE WHEN NEW.saved IS NULL OR NEW.saved < 0 OR NEW.saved > NEW.requested THEN RAISE(ABORT, 'import_runs saved must be 0..requested') END;
			SELECT CASE WHEN NEW.skipped IS NULL OR NEW.skipped < 0 OR NEW.skipped > NEW.requested THEN RAISE(ABORT, 'import_runs skipped must be 0..requested') END;
		END`,
		// Disposable cache: engine vocabulary + lengths. Value stays free-text:
		// corrupt rows are stored then skipped as misses (never served).
		`CREATE TRIGGER IF NOT EXISTS trg_eval_cache_insert BEFORE INSERT ON evaluations_v2 BEGIN
			SELECT CASE WHEN NEW.key_hash IS NULL OR length(NEW.key_hash) < 1 THEN RAISE(ABORT, 'evaluations_v2 key_hash must be non-empty') END;
			SELECT CASE WHEN NEW.engine NOT IN ('maia', 'sf') THEN RAISE(ABORT, 'evaluations_v2 engine must be maia or sf') END;
			SELECT CASE WHEN NEW.cache_key IS NULL OR length(NEW.cache_key) < 1 THEN RAISE(ABORT, 'evaluations_v2 cache_key must be non-empty') END;
			SELECT CASE WHEN NEW.value IS NULL OR length(NEW.value) < 1 THEN RAISE(ABORT, 'evaluations_v2 value must be non-empty') END;
		END`,
		`CREATE TRIGGER IF NOT EXISTS trg_eval_cache_update BEFORE UPDATE ON evaluations_v2 BEGIN
			SELECT CASE WHEN NEW.key_hash IS NULL OR length(NEW.key_hash) < 1 THEN RAISE(ABORT, 'evaluations_v2 key_hash must be non-empty') END;
			SELECT CASE WHEN NEW.engine NOT IN ('maia', 'sf') THEN RAISE(ABORT, 'evaluations_v2 engine must be maia or sf') END;
			SELECT CASE WHEN NEW.cache_key IS NULL OR length(NEW.cache_key) < 1 THEN RAISE(ABORT, 'evaluations_v2 cache_key must be non-empty') END;
			SELECT CASE WHEN NEW.value IS NULL OR length(NEW.value) < 1 THEN RAISE(ABORT, 'evaluations_v2 value must be non-empty') END;
		END`,
	}
	for _, trigger := range triggers {
		if _, err := db.Exec(trigger); err != nil {
			return err
		}
	}
	return nil
}
