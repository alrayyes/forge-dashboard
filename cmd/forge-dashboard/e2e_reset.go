//go:build e2e

package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/singleuser"
	"github.com/go-webauthn/webauthn/webauthn"
)

// e2eResetPath is the route only a build with -tags e2e mounts. Playwright
// calls it before each test (tests/server-fixture.ts) so a worker's server
// starts every test as it was right after the first registration.
const e2eResetPath = "/__e2e/reset"

// keptTables hold the owner and their first passkey, which a reset keeps (the
// extra users, passkeys and labels inside them go), and the schema version,
// which a reset must not forget or the next start would migrate again. Every other table is
// emptied, so a table added later is reset without anyone remembering to list it.
var keptTables = map[string]bool{"users": true, "credential_metadata": true, "schema_version": true}

// withE2EHooks mounts the reset route ahead of next. It needs the raw database
// handle that /readyz's pinger wraps; without it there is nothing to reset.
func withE2EHooks(next http.Handler, deps api.Deps) http.Handler {
	pinger, ok := deps.Database.(schemaPinger)
	if !ok {
		return next
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST "+e2eResetPath, func(w http.ResponseWriter, r *http.Request) {
		if err := resetForE2E(r.Context(), pinger.db, deps, w); err != nil {
			slog.Error("e2e reset failed", "error", err)
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
	})
	mux.Handle("/", next)

	return mux
}

var errNoOwner = errors.New("no user is registered yet")

// findOwner is the first account registered: the oldest user holding a
// passkey, found by the query the single-user cleanup uses.
func findOwner(ctx context.Context, db *sql.DB, store *auth.Store) (*auth.User, error) {
	username, found, err := singleuser.OwnerUsername(ctx, db)
	if err != nil {
		return nil, fmt.Errorf("find owner: %w", err)
	}
	if !found {
		return nil, errNoOwner
	}

	owner, err := store.GetUserByUsername(ctx, username)
	if err != nil {
		return nil, fmt.Errorf("load owner: %w", err)
	}

	return owner, nil
}

// resetForE2E empties saved state, keeps the owner and their first passkey,
// drops the in-memory aggregator, and answers 204 with a fresh session cookie.
func resetForE2E(ctx context.Context, db *sql.DB, deps api.Deps, w http.ResponseWriter) error {
	owner, err := findOwner(ctx, db, deps.AuthStore)
	if err != nil {
		return err
	}
	if len(owner.Credentials) == 0 {
		return errNoOwner
	}
	// The passkey as it was when registered: a login since then bumped its
	// sign counter, which a test that re-adds the registered credential
	// (addOwnerPasskey) would then replay out of date.
	firstPasskey := owner.Credentials[:1]
	firstPasskey[0].Authenticator.SignCount = 0

	if err := rewriteDatabase(ctx, db, owner, firstPasskey); err != nil {
		return err
	}

	if deps.Service != nil {
		deps.Service.Stop()
		deps.Service.Reset()
		deps.Service.Activity().Reset()
	}
	token, err := deps.AuthStore.CreateSession(ctx, auth.SessionTTL)
	if err != nil {
		return fmt.Errorf("create session: %w", err)
	}
	auth.SetSessionCookie(w, token, false)
	w.WriteHeader(http.StatusNoContent)

	return nil
}

// sqlExecer is what emptyTables and keepOwner need, so they run on the
// connection rewriteDatabase holds.
type sqlExecer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// rewriteDatabase empties the tables and trims the owner in one transaction
// that takes the write lock up front. A deferred transaction would start with
// a read, and if the server's own poll or a webhook committed before the first
// delete, SQLite would refuse the upgrade at once (SQLITE_BUSY_SNAPSHOT)
// without waiting out the busy timeout. BEGIN IMMEDIATE waits for the lock
// instead, before any snapshot exists
// (https://www.sqlite.org/lang_transaction.html#deferred_immediate_and_exclusive_transactions).
func rewriteDatabase(ctx context.Context, db *sql.DB, owner *auth.User, firstPasskey []webauthn.Credential) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer func() { _ = conn.Close() }()
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	committed := false
	defer func() {
		if committed {
			return
		}
		if _, err := conn.ExecContext(context.WithoutCancel(ctx), "ROLLBACK"); err != nil {
			// The transaction may still be open: ErrBadConn makes database/sql
			// close this connection instead of returning it to the pool
			// (https://pkg.go.dev/database/sql#Conn.Raw).
			_ = conn.Raw(func(any) error { return driver.ErrBadConn })
		}
	}()
	if err := emptyTables(ctx, conn); err != nil {
		return err
	}
	if err := keepOwner(ctx, conn, owner, firstPasskey); err != nil {
		return err
	}
	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	committed = true

	return nil
}

func emptyTables(ctx context.Context, tx sqlExecer) error {
	rows, err := tx.QueryContext(ctx, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
	if err != nil {
		return fmt.Errorf("list tables: %w", err)
	}
	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			_ = rows.Close()

			return fmt.Errorf("scan table: %w", err)
		}
		tables = append(tables, name)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close tables: %w", err)
	}
	for _, name := range tables {
		if keptTables[name] {
			continue
		}
		if _, err := tx.ExecContext(ctx, fmt.Sprintf(`DELETE FROM %q`, name)); err != nil {
			return fmt.Errorf("empty %s: %w", name, err)
		}
	}

	return nil
}

// keepOwner leaves only the owner, with only their first passkey and its label.
func keepOwner(ctx context.Context, tx sqlExecer, owner *auth.User, firstPasskey []webauthn.Credential) error {
	id := base64.RawURLEncoding.EncodeToString(owner.ID)
	credentials, err := json.Marshal(firstPasskey)
	if err != nil {
		return fmt.Errorf("encode passkey: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM users WHERE id != ?`, id); err != nil {
		return fmt.Errorf("drop other users: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE users SET credentials_json = ? WHERE id = ?`, string(credentials), id); err != nil {
		return fmt.Errorf("trim passkeys: %w", err)
	}
	keptKey := base64.RawURLEncoding.EncodeToString(firstPasskey[0].ID)
	if _, err := tx.ExecContext(ctx, `DELETE FROM credential_metadata WHERE credential_id != ?`, keptKey); err != nil {
		return fmt.Errorf("trim passkey labels: %w", err)
	}
	// Back to the name registration gave it, which a test may have changed.
	if _, err := tx.ExecContext(ctx, `UPDATE credential_metadata SET label = ? WHERE credential_id = ?`, auth.InitialCredentialLabel, keptKey); err != nil {
		return fmt.Errorf("restore passkey label: %w", err)
	}

	return nil
}
