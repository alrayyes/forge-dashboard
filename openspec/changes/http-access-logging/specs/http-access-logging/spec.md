# Spec Delta

## Purpose

Ensures every inbound HTTP request the server handles is logged with enough information to see what was served, without ever leaking a credential into the log output.

## ADDED Requirements

### Requirement: Every completed request produces one structured log line

The system SHALL log one structured entry per completed HTTP request, recording at minimum the request method, path, response status, duration, and remote address.

#### Scenario: A normal request is logged

- **WHEN** any HTTP request to the server completes
- **THEN** a structured log entry is emitted recording its method, path, status, duration, and remote address

### Requirement: Log level reflects the response outcome

The system SHALL choose the log level for a request's entry based on its response status: Error for a 5xx response, Warn for a 4xx response, and Info for any other response.

#### Scenario: A server error is logged at Error level

- **WHEN** a request completes with a 5xx response status
- **THEN** its log entry is recorded at Error level

#### Scenario: A client error is logged at Warn level

- **WHEN** a request completes with a 4xx response status
- **THEN** its log entry is recorded at Warn level

#### Scenario: A successful request is logged at Info level

- **WHEN** a request completes with a 2xx or 3xx response status
- **THEN** its log entry is recorded at Info level

### Requirement: An authenticated request's log entry names the signed-in user

The system SHALL include the signed-in username in a request's log entry when the request carried a valid session or API token.

#### Scenario: An authenticated request's entry includes the username

- **WHEN** a request completes with a valid session cookie or API token that resolves to a user
- **THEN** its log entry includes that user's username

### Requirement: No credential or secret ever appears in a request's log entry

The system SHALL NOT include the `Authorization` header, `Cookie` header, raw query string, or any request/response body content in a request's log entry.

#### Scenario: A bearer token never appears in the log

- **WHEN** a request carries an `Authorization: Bearer <token>` header
- **THEN** the raw header value never appears anywhere in that request's log entry

#### Scenario: A session cookie never appears in the log

- **WHEN** a request carries a session cookie
- **THEN** the raw cookie value never appears anywhere in that request's log entry

### Requirement: A rejected or unauthenticated request is still logged

The system SHALL log a request that is rejected by authentication, the same as any other request.

#### Scenario: An unauthenticated request to a protected endpoint is logged

- **WHEN** a request without valid credentials reaches an endpoint that requires authentication and is rejected
- **THEN** a log entry is still emitted for that request, at the level its rejection status implies

### Requirement: Health-check traffic does not appear at Info level

The system SHALL log a request to the health-check endpoint at Debug level, or omit it from access logging, rather than at Info level.

#### Scenario: A health check does not appear in default-level output

- **WHEN** a request to the health-check endpoint completes successfully
- **THEN** its log entry, if any, is at Debug level, not Info
