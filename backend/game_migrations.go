package main

import "database/sql"

func migrateGameTemperature(db *sql.DB) error {
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
		if name == "temperature" {
			found = true
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if !found {
		_, err = db.Exec("ALTER TABLE games ADD COLUMN temperature REAL NOT NULL DEFAULT 0")
	}
	return err
}
