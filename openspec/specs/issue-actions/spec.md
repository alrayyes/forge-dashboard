# issue-actions Specification

## Purpose

Lets a user close an issue, with or without a comment, and reopen it, from the issue's pop-up, following the pull request Close action.

## Requirements

### Requirement: The issue pop-up offers Close and Close with a comment

The system SHALL offer **Close issue** and **Close with a comment** in the footer of an open issue's pop-up, and no merge or rebase action.

#### Scenario: Closing asks for confirmation

- **WHEN** a user chooses Close issue
- **THEN** the footer asks to confirm, nothing is sent to the forge yet, and Escape or Cancel drops the step without closing the pop-up

#### Scenario: Closing with a comment posts the comment first

- **WHEN** a user writes a comment and sends it with Comment and close
- **THEN** the comment is posted, then the issue is closed, and a blank comment is not sent

### Requirement: A close keeps the pop-up open and Reopen is the undo

The system SHALL keep the pop-up open after a close, show the issue as Closed in its header, and offer Reopen issue with focus on it, with no timer.

#### Scenario: Reopening

- **WHEN** a user chooses Reopen issue after a close
- **THEN** the issue is reopened, the header shows Open, and the footer returns to Close and Close with a comment

### Requirement: A half-done close says which half happened

The system SHALL, when the comment posts but the close fails, say that the comment was posted and the issue is still open, and offer a retry of the close only; when the comment fails, nothing is posted and the retry is of the comment.

#### Scenario: The close fails after the comment posted

- **WHEN** the comment is posted and the forge then fails the close
- **THEN** the pop-up offers Retry close, and retrying never posts the comment again

### Requirement: A forge refusal locks the actions with its reason

The system SHALL lock the issue actions and print the reason when the forge refuses with a missing permission, a spent rate limit or an unreachable forge, and SHALL name the token permission that is missing.

#### Scenario: The token cannot write issues

- **WHEN** the forge refuses a close because the token has no write access to issues
- **THEN** both buttons are locked, the reason names the permission to grant, and clicking them does nothing

### Requirement: The issue actions are an HTTP API

The system SHALL expose `POST /api/issues/close`, `POST /api/issues/reopen` and `POST /api/issues/comment`, each answering 204 on success and the shared action error shape on a refusal.

#### Scenario: A refused action

- **WHEN** the forge refuses an issue action
- **THEN** the response carries a code of permission, rate_limited or forge_error and a plain message
