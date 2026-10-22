INSERT INTO users (id, username, display_name, credentials_json, created_at) VALUES ('b3duZXI', 'ryan', 'Ryan', '[{}]', '2026-01-01 00:00:00');
INSERT INTO ceremonies (username, kind, session_json, expires_at) VALUES ('ryan', 'login', '{}', '2099-01-01 00:00:00');
INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES ('session-cookie', 'b3duZXI', '2099-01-01 00:00:00', '2026-02-01 00:00:00');
INSERT INTO api_tokens (id, user_id, label, token_hash, created_at, expires_at, last_used_at) VALUES
	('t1', 'b3duZXI', 'ci', 'hash-one', '2026-02-01 00:00:00', '2099-01-01 00:00:00', '2026-03-01 00:00:00'),
	('t2', 'b3duZXI', 'mcp', 'hash-two', '2026-02-02 00:00:00', '2099-01-01 00:00:00', NULL);
INSERT INTO credential_metadata (user_id, credential_id, label, created_at) VALUES
	('b3duZXI', 'cred-a', 'Laptop', '2026-01-01 00:00:00'),
	('b3duZXI', 'cred-b', 'Phone', '2026-01-02 00:00:00');
INSERT INTO request_log (logged_at, forge, account_id, method, endpoint, status_code, outcome, rate_limit_limit, rate_limit_remaining, rate_limit_resets_at, rate_limit_cost) VALUES
	('2026-04-01 00:00:00', 'github', 'b3duZXI', 'GET', '/user', 200, 'success', 5000, 4999, '2026-04-01 01:00:00', 1),
	('2026-04-01 00:00:01', 'forgejo', NULL, 'GET', '/api/v1/version', NULL, 'network', NULL, NULL, NULL, NULL);
