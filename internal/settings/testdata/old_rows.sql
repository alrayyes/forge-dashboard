INSERT INTO users (id, username, credentials_json, created_at) VALUES ('owner', 'ryan', '[{}]', '2026-01-01 00:00:00');
INSERT INTO user_credentials (user_id, github_token, github_username, forgejo_url, forgejo_token, webhook_token, webhook_secret, renovate_authors, hide_dependency_dashboard, ignored_titles, filter_state, theme, timezone, github_app_installation_id, updated_at)
	VALUES ('owner', 'sealed-gh', 'ryan', 'https://forge.example', 'sealed-fj', 'hook-token', 'hook-secret', 'bot', 1, '["wip"]', '{"q":"x"}', 'dark', 'Europe/Amsterdam', 42, '2026-02-02 00:00:00');
INSERT INTO webhook_deliveries VALUES ('owner', 'github', 'a/b', '2026-03-03 00:00:00');
INSERT INTO ignored_repos VALUES ('owner', 'github', 'a/c', 1, 0);
INSERT INTO auto_update_branch_repos VALUES ('owner', 'forgejo', 'a/d');
INSERT INTO auto_merge_intents VALUES ('owner', 'github', 'a/e', 7, '2026-04-04 00:00:00');
INSERT INTO hidden_pull_requests VALUES ('owner', 'github', 'a/f', 8, NULL);
INSERT INTO queued_actions (id, user_id, action, forge, repo_full_name, number, status, run_at, created_at, code, message)
	VALUES ('abc123', 'owner', 'merge', 'github', 'a/g', 9, 'queued', '2026-05-05 00:00:00', '2026-05-04 00:00:00', '', '');
INSERT INTO pull_request_auto_update VALUES ('owner', 'github', 'a/h', 10, 0);
