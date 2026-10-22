-- The auth tables as releases before the user id was dropped created them.
-- users carries the extra columns older releases had; the migration ignores them.
CREATE TABLE users (
	id TEXT PRIMARY KEY,
	username TEXT NOT NULL UNIQUE,
	display_name TEXT NOT NULL,
	credentials_json TEXT NOT NULL DEFAULT '[]',
	created_at TIMESTAMP NOT NULL
);
CREATE TABLE ceremonies (
	username TEXT NOT NULL,
	kind TEXT NOT NULL,
	session_json TEXT NOT NULL,
	expires_at TIMESTAMP NOT NULL,
	PRIMARY KEY (username, kind)
);
CREATE TABLE sessions (
	token TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id),
	expires_at TIMESTAMP NOT NULL,
	created_at TIMESTAMP NOT NULL
);
CREATE TABLE api_tokens (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id),
	label TEXT NOT NULL,
	token_hash TEXT NOT NULL UNIQUE,
	created_at TIMESTAMP NOT NULL,
	expires_at TIMESTAMP,
	last_used_at TIMESTAMP
);
CREATE TABLE credential_metadata (
	user_id TEXT NOT NULL,
	credential_id TEXT NOT NULL,
	label TEXT NOT NULL,
	created_at TIMESTAMP NOT NULL,
	PRIMARY KEY (user_id, credential_id)
);
CREATE TABLE request_log (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	logged_at TIMESTAMP NOT NULL,
	forge TEXT NOT NULL,
	account_id TEXT REFERENCES users(id),
	method TEXT NOT NULL,
	endpoint TEXT NOT NULL,
	status_code INTEGER,
	outcome TEXT NOT NULL,
	rate_limit_limit INTEGER,
	rate_limit_remaining INTEGER,
	rate_limit_resets_at TIMESTAMP,
	rate_limit_cost INTEGER
);
