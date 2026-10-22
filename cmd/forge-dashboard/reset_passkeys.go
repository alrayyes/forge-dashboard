package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/auth"
)

// errResetNeedsYes is returned when the owner still has passkeys and the
// operator did not pass --yes. Clearing them signs the owner out everywhere,
// so it is never a default.
var errResetNeedsYes = errors.New("the owner still has passkeys: re-run with --yes to clear them")

// resetOptions are the flags of `forge-dashboard reset-passkeys`.
type resetOptions struct {
	// Yes confirms clearing passkeys the owner still has.
	Yes bool
	// Tokens also revokes the owner's API tokens.
	Tokens bool
}

func parseResetOptions(args []string) (resetOptions, error) {
	var opts resetOptions

	fs := flag.NewFlagSet("reset-passkeys", flag.ContinueOnError)
	fs.BoolVar(&opts.Yes, "yes", false, "confirm clearing the passkeys the owner still has")
	fs.BoolVar(&opts.Tokens, "tokens", false, "also revoke the owner's API tokens")

	if err := fs.Parse(args); err != nil {
		return resetOptions{}, fmt.Errorf("reset-passkeys: %w", err)
	}

	return opts, nil
}

// runResetPasskeys is the subcommand: it needs the database and nothing else
// the server sets up, so it runs from `docker exec` on the host with the same
// DB_PATH as the server. Operator access to the host is what authorises it.
func runResetPasskeys(args []string) error {
	opts, err := parseResetOptions(args)
	if err != nil {
		return err
	}

	db, err := openDatabase()
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()

	return resetPasskeys(context.Background(), db, envOr("DB_PATH", "/data/forge-dashboard.db"), opts, os.Stdout, slog.Default())
}

// resetPasskeys clears the owner's passkeys so the first-visit registration is
// open again, and attaches the next passkey to the same user row, so every
// saved setting and the webhook token survive. The database is copied aside
// first. Nothing happens, and nothing is backed up, when there is no passkey to
// clear.
func resetPasskeys(ctx context.Context, db *sql.DB, dbPath string, opts resetOptions, out io.Writer, log *slog.Logger) error {
	store := auth.NewStore(db)
	if err := store.Init(ctx); err != nil {
		return fmt.Errorf("init auth store: %w", err)
	}

	owner, err := store.Owner(ctx)
	if errors.Is(err, auth.ErrNotFound) || (err == nil && len(owner.Credentials) == 0) {
		_, _ = fmt.Fprintln(out, "Nothing to reset: no passkey is registered, so registration is already open.")

		return nil
	}
	if err != nil {
		return fmt.Errorf("reset-passkeys: find the owner: %w", err)
	}

	if !opts.Yes {
		_, _ = fmt.Fprintf(out, "User %q has %d passkey(s). Clearing them signs the owner out everywhere.\nRe-run with --yes to go ahead.\n",
			owner.Username, len(owner.Credentials))

		return errResetNeedsYes
	}

	backup, err := backUpBeforeReset(ctx, db, dbPath)
	if err != nil {
		return err
	}

	res, err := store.ResetPasskeys(ctx, opts.Tokens)
	if err != nil {
		return fmt.Errorf("reset-passkeys: %w", err)
	}

	log.Warn("reset-passkeys: cleared the owner's passkeys",
		slog.String("username", res.Username),
		slog.Int("passkeys", res.Passkeys),
		slog.Int("sessions", res.Sessions),
		slog.Int("api_tokens_revoked", res.Tokens),
		slog.String("backup", backup))

	_, _ = fmt.Fprintf(out, "Cleared %d passkey(s) and %d session(s) for %q; %d API token(s) revoked. Backup: %s\n"+
		"Settings are kept. Registration is open until the owner finishes a passkey: open the site now.\n",
		res.Passkeys, res.Sessions, res.Username, res.Tokens, backup)

	return nil
}

// backUpBeforeReset copies the database next to the original. The copy holds
// every secret the database does, so the file is created 0600 before SQLite
// writes to it (VACUUM INTO accepts an existing empty file). O_EXCL makes a
// name clash fail instead of overwriting an earlier backup.
func backUpBeforeReset(ctx context.Context, db *sql.DB, dbPath string) (string, error) {
	path := fmt.Sprintf("%s.before-reset-passkeys-%s", dbPath, time.Now().UTC().Format("20060102T150405.000000000Z"))

	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600) //nolint:gosec // path is the configured database path plus a fixed suffix
	if err != nil {
		return "", fmt.Errorf("reset-passkeys: create the backup: %w", err)
	}
	if err := f.Close(); err != nil {
		return "", fmt.Errorf("reset-passkeys: create the backup: %w", err)
	}
	if _, err := db.ExecContext(ctx, `VACUUM INTO ?`, path); err != nil {
		_ = os.Remove(path)

		return "", fmt.Errorf("reset-passkeys: back up the database: %w", err)
	}

	return path, nil
}
