package settings

import "testing"

func TestLegacyColumnsKeysAreRebuiltTables(t *testing.T) {
	t.Parallel()

	known := map[string]bool{}
	for _, r := range rebuilds {
		known[r.old] = true
	}
	for table, columns := range legacyColumns {
		if !known[table] {
			t.Errorf("legacyColumns key %q is not an old table in rebuilds", table)
		}
		if len(columns) == 0 {
			t.Errorf("legacyColumns[%q] has no columns", table)
		}
	}
}
