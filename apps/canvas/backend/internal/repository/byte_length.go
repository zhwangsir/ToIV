package repository

import "regexp"

// The storage-usage queries were written for SQLite, where length(CAST(x AS BLOB)) is the byte
// length. PostgreSQL has no BLOB type, so the same SQL fails with a PgError and every quota-checked
// write (canvas save, asset/creation writes for non-admin accounts) answered 500 on canvas-api-pg.
var sqliteByteLength = regexp.MustCompile(`length\(CAST\(COALESCE\(([A-Za-z_][A-Za-z0-9_]*),\s*''\) AS BLOB\)\)`)

// portableByteLength rewrites the SQLite byte-length idiom for the active dialect.
func portableByteLength(dialect, query string) string {
	if dialect != "postgres" {
		return query
	}
	return sqliteByteLength.ReplaceAllString(query, `octet_length(COALESCE(CAST($1 AS TEXT), ''))`)
}
