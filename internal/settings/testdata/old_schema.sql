-- The settings tables as releases before the user id was dropped created
-- them, with the users table the migration looks the owner up in.
CREATE TABLE users (
	id TEXT PRIMARY KEY,
	username TEXT NOT NULL UNIQUE,
	credentials_json TEXT NOT NULL DEFAULT '[]',
	created_at TIMESTAMP NOT NULL
);
CREATE TABLE user_credentials (
	user_id TEXT PRIMARY KEY,
	github_token TEXT NOT NULL DEFAULT '',
	github_username TEXT NOT NULL DEFAULT '',
	forgejo_url TEXT NOT NULL DEFAULT '',
	forgejo_token TEXT NOT NULL DEFAULT '',
	forgejo_username TEXT NOT NULL DEFAULT '',
	webhook_token TEXT NOT NULL DEFAULT '',
	webhook_secret TEXT NOT NULL DEFAULT '',
	renovate_rebase_label TEXT NOT NULL DEFAULT '',
	renovate_authors TEXT NOT NULL DEFAULT '',
	hide_dependency_dashboard INTEGER NOT NULL DEFAULT 0,
	ignored_titles TEXT NOT NULL DEFAULT '[]',
	filter_state TEXT NOT NULL DEFAULT '{}',
	theme TEXT NOT NULL DEFAULT '',
	timezone TEXT NOT NULL DEFAULT '',
	github_app_installation_id INTEGER NOT NULL DEFAULT 0,
	updated_at TIMESTAMP NOT NULL
);
CREATE TABLE webhook_deliveries (
	user_id TEXT NOT NULL,
	forge TEXT NOT NULL,
	repo_full_name TEXT NOT NULL,
	last_seen_at TIMESTAMP NOT NULL,
	PRIMARY KEY (user_id, forge, repo_full_name)
);
CREATE TABLE ignored_repos (
	user_id TEXT NOT NULL,
	forge TEXT NOT NULL,
	repo_full_name TEXT NOT NULL,
	ignore_prs BOOLEAN NOT NULL DEFAULT 1,
	ignore_issues BOOLEAN NOT NULL DEFAULT 1,
	PRIMARY KEY (user_id, forge, repo_full_name)
);
CREATE TABLE auto_update_branch_repos (
	user_id TEXT NOT NULL,
	forge TEXT NOT NULL,
	repo_full_name TEXT NOT NULL,
	PRIMARY KEY (user_id, forge, repo_full_name)
);
CREATE TABLE auto_merge_intents (
	user_id TEXT NOT NULL,
	forge TEXT NOT NULL,
	repo_full_name TEXT NOT NULL,
	number INTEGER NOT NULL,
	armed_at TIMESTAMP NOT NULL,
	PRIMARY KEY (user_id, forge, repo_full_name, number)
);
CREATE TABLE hidden_pull_requests (
	user_id TEXT NOT NULL,
	forge TEXT NOT NULL,
	repo_full_name TEXT NOT NULL,
	number INTEGER NOT NULL,
	hidden_until TIMESTAMP,
	PRIMARY KEY (user_id, forge, repo_full_name, number)
);
CREATE TABLE queued_actions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	action TEXT NOT NULL,
	forge TEXT NOT NULL,
	repo_full_name TEXT NOT NULL,
	number INTEGER NOT NULL,
	status TEXT NOT NULL,
	run_at TIMESTAMP NOT NULL,
	created_at TIMESTAMP NOT NULL,
	finished_at TIMESTAMP,
	code TEXT NOT NULL DEFAULT '',
	message TEXT NOT NULL DEFAULT ''
);
CREATE INDEX queued_actions_user ON queued_actions (user_id);
CREATE TABLE pull_request_auto_update (
	user_id TEXT NOT NULL,
	forge TEXT NOT NULL,
	repo_full_name TEXT NOT NULL,
	number INTEGER NOT NULL,
	enabled BOOLEAN NOT NULL,
	PRIMARY KEY (user_id, forge, repo_full_name, number)
);
