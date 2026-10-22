// Package dbdsn builds the DSN the app opens its SQLite file with, so
// production and the tests' databases wait out a busy lock the same way.
package dbdsn

// options are the connection options every database of this app is opened
// with: wait up to thirty seconds for a lock instead of failing at once with
// SQLITE_BUSY, and journal in WAL mode so readers do not block the writer.
const options = "?_busy_timeout=30000&_journal_mode=WAL"

// For returns the DSN that opens the SQLite file at path.
func For(path string) string {
	return path + options
}
