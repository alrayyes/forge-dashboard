//go:build ignore

// Saves a dummy GitHub token in the dashboard's database, so the next start
// begins the first refresh by itself (start-at-boot) with nobody signed in.
//
//	ENCRYPTION_KEY=... go run scripts/memory-bench/seed.go /path/to/forge-dashboard.db
package main

import (
	"context"
	"database/sql"
	"log"
	"os"

	"github.com/alrayyes/forge-dashboard/internal/dbdsn"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	_ "modernc.org/sqlite"
)

func main() {
	if len(os.Args) != 2 {
		log.Fatal("usage: seed.go <database file>")
	}
	cipher, err := settings.NewCipher(os.Getenv("ENCRYPTION_KEY"))
	if err != nil {
		log.Fatal(err)
	}
	db, err := sql.Open("sqlite", dbdsn.For(os.Args[1]))
	if err != nil {
		log.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	store := settings.NewStore(db, cipher)
	ctx := context.Background()
	if err := store.Init(ctx); err != nil {
		log.Fatal(err)
	}
	if err := store.Set(ctx, settings.Credentials{GitHubToken: "dummy-token-not-real"}); err != nil {
		log.Fatal(err)
	}
}
