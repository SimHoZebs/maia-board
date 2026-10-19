package store

import "database/sql"

func migrateGameSchema(db *sql.DB) error {
	if err := ensureGameColumn(db, "temperature", "ALTER TABLE games ADD COLUMN temperature REAL NOT NULL DEFAULT 0 CHECK (temperature BETWEEN 0 AND 2)"); err != nil {
		return err
	}
	if err := ensureGameColumn(db, "result", "ALTER TABLE games ADD COLUMN result TEXT NOT NULL DEFAULT '' CHECK (result IN ('', 'resigned'))"); err != nil {
		return err
	}
	if err := ensureGameColumn(db, "rating_diff", "ALTER TABLE games ADD COLUMN rating_diff INTEGER CHECK (rating_diff IS NULL OR (rating_diff BETWEEN -1000 AND 1000))"); err != nil {
		return err
	}
	return migrateGameTimeColumns(db)
}

func migrateGameTimeColumns(db *sql.DB) error {
	if err := ensureGameColumn(db, "time_control", "ALTER TABLE games ADD COLUMN time_control TEXT CHECK (time_control IS NULL OR (length(time_control) BETWEEN 1 AND 32))"); err != nil {
		return err
	}
	if err := ensureGameColumn(db, "speed", "ALTER TABLE games ADD COLUMN speed TEXT CHECK (speed IS NULL OR speed IN ('ultrabullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence', 'unlimited'))"); err != nil {
		return err
	}
	return ensureGameColumn(db, "clocks", "ALTER TABLE games ADD COLUMN clocks TEXT CHECK (clocks IS NULL OR json_valid(clocks))")
}

func ensureGameColumn(db *sql.DB, column, alter string) error {
	rows, err := db.Query("PRAGMA table_info(games)")
	if err != nil {
		return err
	}
	found := false
	for rows.Next() {
		var id, notNull, primary int
		var name, kind string
		var fallback any
		if err := rows.Scan(&id, &name, &kind, &notNull, &fallback, &primary); err != nil {
			rows.Close()
			return err
		}
		if name == column {
			found = true
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if !found {
		_, err = db.Exec(alter)
	}
	return err
}
