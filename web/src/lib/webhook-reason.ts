// What a Webhooks row says about a repo the dashboard could not put a hook on
// (#4682). The server names the reason; the page words it.

export type WebhookReasonFields = {
  webhookReason?: string;
  webhookReasonDetail?: string;
  webhookNextAttemptAt?: string;
};

export type WebhookNote = {
  // One line, shown on the row.
  line: string;
  // The longer text, for hover and focus.
  detail: string;
};

// A repo the credential can't administer (no_permission) is worded by the
// row's own lock text, which knows which fix applies. A reason this page
// doesn't know yet shows nothing.
export function webhookNote(
  repo: WebhookReasonFields,
  formatTime: (iso: string) => string,
): WebhookNote | null {
  if (repo.webhookReason === 'forge_unavailable') {
    return {
      line: "The forge didn't answer. The dashboard will try again.",
      detail:
        'The forge was rate limited or unreachable on the last attempt, so no webhook was created. The dashboard asks again on its own.',
    };
  }
  if (repo.webhookReason === 'forge_refused') {
    const when = repo.webhookNextAttemptAt
      ? `Next try ${formatTime(repo.webhookNextAttemptAt)}.`
      : 'The dashboard will try again.';
    return {
      line: `The forge refused to create it. ${when}`,
      detail: repo.webhookReasonDetail
        ? `The forge said: ${repo.webhookReasonDetail}`
        : 'The forge refused to create the webhook and gave no reason.',
    };
  }
  return null;
}
