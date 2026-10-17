package store

import "database/sql"

func migrateGameSchema(db *sql.DB) error {
	if err := ensureGameColumn(db, "temperature", "ALTER TABLE games ADD COLUMN temperature REAL NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	if err := ensureGameColumn(db, "result", "ALTER TABLE games ADD COLUMN result TEXT NOT NULL DEFAULT ''"); err != nil {
		return err
	}
	if err := ensureGameColumn(db, "rating_diff", "ALTER TABLE games ADD COLUMN rating_diff INTEGER"); err != nil {
		return err
	}
	return migrateGameTimeColumns(db)
}

func migrateGameTimeColumns(db *sql.DB) error {
	if err := ensureGameColumn(db, "time_control", "ALTER TABLE games ADD COLUMN time_control TEXT"); err != nil {
		return err
	}
	if err := ensureGameColumn(db, "speed", "ALTER TABLE games ADD COLUMN speed TEXT"); err != nil {
		return err
	}
	return ensureGameColumn(db, "clocks", "ALTER TABLE games ADD COLUMN clocks TEXT")
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
