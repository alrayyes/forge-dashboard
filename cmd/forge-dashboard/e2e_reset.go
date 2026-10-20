//go:build e2e

package main

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/go-webauthn/webauthn/webauthn"
)

// e2eResetPath is the route only a build with -tags e2e mounts. Playwright
// calls it before each test (tests/server-fixture.ts) so a worker's server
// starts every test as it was right after the first registration.
const e2eResetPath = "/__e2e/reset"

// keptTables hold the owner and their first passkey, which a reset keeps (the
// extra users, passkeys and labels inside them go). Every other table is
// emptied, so a table added later is reset without anyone remembering to list it.
var keptTables = map[string]bool{"users": true, "credential_metadata": true}

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

// oldestUser is the owner: the first account registered. ListUsers orders by
// username, so the creation time decides.
func oldestUser(users []*auth.User) *auth.User {
	var owner *auth.User
	for _, u := range users {
		if owner == nil || u.CreatedAt.Before(owner.CreatedAt) {
			owner = u
		}
	}

	return owner
}

// resetForE2E empties per-user state, keeps the owner and their first passkey,
// drops the in-memory aggregators, and answers 204 with a fresh session cookie.
func resetForE2E(ctx context.Context, db *sql.DB, deps api.Deps, w http.ResponseWriter) error {
	users, err := deps.AuthStore.ListUsers(ctx)
	if err != nil {
		return fmt.Errorf("list users: %w", err)
	}
	owner := oldestUser(users)
	if owner == nil || len(owner.Credentials) == 0 {
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

	if deps.Manager != nil {
		deps.Manager.Stop()
	}
	token, err := deps.AuthStore.CreateSession(ctx, owner.ID, auth.SessionTTL)
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
		if !committed {
			_, _ = conn.ExecContext(context.WithoutCancel(ctx), "ROLLBACK")
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
	if _, err := tx.ExecContext(ctx, `DELETE FROM credential_metadata WHERE NOT (user_id = ? AND credential_id = ?)`, id, keptKey); err != nil {
		return fmt.Errorf("trim passkey labels: %w", err)
	}

	return nil
}
