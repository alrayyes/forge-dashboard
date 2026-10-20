// What the page says about a pull request's automatic branch update. The server
// works out the state (components.schemas.AutoUpdate); nothing here decides it.

export type AutoUpdate = {
  enabled: boolean;
  source: 'repo' | 'pullRequest';
  unavailable: { code: string; reason: string } | null;
};

export type AutoUpdateControl = {
  checked: boolean;
  // The checkbox is drawn aria-disabled, still focusable, with the reason as
  // its visible note.
  disabled: boolean;
  note: string;
  // Show "Use the repo's setting": the pull request has a choice of its own.
  canReset: boolean;
};

// The checkbox's state, or null where the server sent none (an older server).
export function autoUpdateControl(
  state: AutoUpdate | undefined,
): AutoUpdateControl | null {
  if (!state) return null;
  if (state.unavailable) {
    return {
      checked: false,
      disabled: true,
      note: state.unavailable.reason,
      canReset: false,
    };
  }
  const own = state.source === 'pullRequest';
  return {
    checked: state.enabled,
    disabled: false,
    note: own ? 'Set for this pull request.' : "From the repo's setting.",
    canReset: own,
  };
}

// The row's marker, only where the pull request's value is its own choice.
export function autoUpdateBadge(state: AutoUpdate | undefined): string | null {
  if (!state || state.unavailable || state.source !== 'pullRequest')
    return null;
  return state.enabled ? 'Auto-update on' : 'Auto-update off';
}
