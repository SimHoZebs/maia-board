package main

import "database/sql"

func migrateGameSchema(db *sql.DB) error {
	if err := ensureGameColumn(db, "temperature", "ALTER TABLE games ADD COLUMN temperature REAL NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	return ensureGameColumn(db, "result", "ALTER TABLE games ADD COLUMN result TEXT NOT NULL DEFAULT ''")
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
