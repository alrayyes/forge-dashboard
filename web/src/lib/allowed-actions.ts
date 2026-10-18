// What the server says a pull request offers (#805), as carried on every
// pull request by GET /api/dashboard, the stream and the refresh response
// (components.schemas.AllowedAction). A row renders only what is listed and
// holds no copy of the rules that decided it. Live state stays here, in the
// page: a rate-limited or unreachable forge, a missing token, an action
// already in flight.

export type ActionName =
  | 'merge'
  | 'close'
  | 'update_branch'
  | 'auto_merge'
  | 'cancel_auto_merge'
  | 'dependabot_rebase'
  | 'dependabot_recreate'
  | 'renovate_rebase'
  | 'rerun_checks';

export type Blocked = {
  code: string;
  // Plain words, safe to show a person.
  message: string;
  // What unlocks it, when something does.
  next?: string;
};

export type AllowedAction = {
  action: ActionName;
  blocked?: Blocked;
  // True on the one action the server wants drawn as the main button. Absent
  // on every other entry, and from a server that predates the field.
  primary?: boolean;
};

// The entry for one action, or undefined when the server doesn't offer it.
// An action that doesn't apply is absent, not listed as blocked.
export function findAction(
  item: { allowedActions?: AllowedAction[] },
  action: ActionName,
): AllowedAction | undefined {
  return item.allowedActions?.find((a) => a.action === action);
}

// The one entry the server marked primary, or undefined when none is. The
// server guarantees at most one, never a blocked one, so this only reads it
// and holds no rule of its own. Should two ever arrive, the first wins; the
// page doesn't pick between them.
export function primaryAction(item: {
  allowedActions?: AllowedAction[];
}): AllowedAction | undefined {
  return item.allowedActions?.find((a) => a.primary === true);
}
