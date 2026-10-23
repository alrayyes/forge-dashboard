// The issue dialog's footer: Close, Close with a comment, and Reopen as the
// undo. It follows the pull request Close action (a confirm step, the dialog
// staying open on the closed state, a refusal locking the buttons with its
// reason) and adds what a comment brings: it posts first and the close second,
// so when one half fails the dialog says which half happened and offers only
// the other, and nothing is posted twice.
import {
  type ActionRequestError,
  interpretActionFailure,
  NETWORK_FAILURE,
  readActionFailure,
} from './action-error';
import { isReadOnlyLock, type LockInfo } from './lock-info';
import type { DetailsChrome } from './PullRequestDetailsDialog.svelte';

export type IssueTarget = { forge: string; repo: string; number: number };

export type IssueActionsHost = {
  // Draws the footer area. Synchronous: this finds its new nodes by id.
  render(chrome: DetailsChrome): void;
  // The state shown in the dialog's header.
  showClosed(closed: boolean): void;
  // Reads the dashboard again, so the list and the dialog's own details follow.
  refresh(): void;
  announce(text: string): void;
  // Why the forge can't be written to right now, from the last snapshot.
  forgeLock(forge: string): LockInfo | null;
  rateLimitReason(forge: string, resetsAt: string | undefined): string;
  forgeLabel(forge: string): string;
};

type Phase =
  | 'idle'
  | 'confirming'
  | 'composing'
  | 'working'
  | 'closed'
  | 'reopening';

type Retry = 'comment' | 'close' | 'reopen';

export const CLOSED_STATUS = 'Closed. Reopen it if that was a mistake.';
export const BLANK_COMMENT =
  'Write a comment first, or choose Close issue to close it without one.';

// How long after a close of ours a read saying "open" is not believed: a
// forge can answer from a copy that has not caught up yet.
const SETTLE_MS = 15_000;

const ID = {
  close: 'issue-action-close',
  confirm: 'issue-action-confirm',
  comment: 'issue-action-comment',
  field: 'issue-action-field',
  send: 'issue-action-send',
  retry: 'issue-action-retry',
  reopen: 'issue-action-reopen',
  lock: 'issue-action-lock',
};

function node<T extends HTMLElement>(
  tag: string,
  className = '',
  text = '',
): T {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e as T;
}

function button(
  id: string,
  label: string,
  className = 'row-action',
  onClick?: () => void,
): HTMLButtonElement {
  const b = node<HTMLButtonElement>('button', className, label);
  b.type = 'button';
  b.id = id;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

function post(path: string, body: Record<string, unknown>): Promise<void> {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  }).then(
    (res) => {
      if (res.status === 401) {
        window.location.href = '/login.html';
        throw new Error('session expired');
      }
      if (res.ok) return;
      return readActionFailure(res).then((err) => {
        throw err;
      });
    },
    () => {
      const err: ActionRequestError = new Error(NETWORK_FAILURE);
      throw err;
    },
  );
}

export function createIssueActions(host: IssueActionsHost) {
  let target: IssueTarget | null = null;
  let session = 0;
  let phase: Phase = 'idle';
  let text = '';
  let commentPosted = false;
  // Whether the attempt in hand carries a comment, for a retry to repeat it.
  let withNote = false;
  let closedAt = 0;
  let failure: { line: string; retry?: Retry } | null = null;
  let locked: string | null = null;

  const ref = () => ({
    forge: target?.forge,
    fullName: target?.repo,
    number: target?.number,
  });

  function lockReason(): string | null {
    if (locked) return locked;
    if (!target || phase === 'closed' || phase === 'reopening') return null;
    const lock = host.forgeLock(target.forge);
    return lock && (lock.code === 'permission' || isReadOnlyLock(lock))
      ? lock.reason
      : null;
  }

  function feedbackLine(): HTMLElement | null {
    if (!failure) return null;
    const p = node('p', 'status-area details-issue-failure', failure.line);
    p.setAttribute('role', 'alert');
    return p;
  }

  function lockedActions(reason: string, names: string[]): HTMLElement[] {
    const note = node('p', 'row-action-note', reason);
    note.id = ID.lock;
    const out = names.map((name) => {
      const b = button(ID.close + names.indexOf(name), name);
      b.setAttribute('aria-disabled', 'true');
      b.setAttribute('aria-describedby', ID.lock);
      const wrap = node('span', 'row-action-locked');
      wrap.appendChild(b);
      return wrap;
    });
    return [...out, note];
  }

  function composer(): HTMLElement {
    const wrap = node('div', 'issue-comment-option');
    const label = node<HTMLLabelElement>(
      'label',
      'issue-comment-label',
      'Comment',
    );
    label.htmlFor = ID.field;
    const field = node<HTMLTextAreaElement>('textarea', 'issue-comment-field');
    field.id = ID.field;
    field.rows = 4;
    field.value = text;
    field.readOnly = phase === 'working';
    field.addEventListener('input', () => {
      text = field.value;
    });
    wrap.append(label, field);
    return wrap;
  }

  function chrome(): DetailsChrome {
    const status =
      phase === 'closed' || phase === 'reopening'
        ? node('p', 'status-area details-closed', CLOSED_STATUS)
        : null;
    const feedback = feedbackLine();
    const reason = lockReason();

    if (phase === 'closed' || phase === 'reopening') {
      if (reason)
        return {
          status,
          feedback,
          option: null,
          actions: lockedActions(reason, ['Reopen issue']),
        };
      const working = phase === 'reopening';
      const reopen = button(
        ID.reopen,
        working ? 'Reopening…' : 'Reopen issue',
        'row-action reopen details-action-primary',
        () => {
          if (phase === 'closed') void reopenNow();
        },
      );
      if (working) reopen.setAttribute('aria-disabled', 'true');
      return { status, feedback, option: null, actions: [reopen] };
    }

    // A half that failed: only that half is offered again.
    if (failure?.retry && failure.retry !== 'reopen' && !reason) {
      const retry = button(
        ID.retry,
        failure.retry === 'comment' ? 'Retry comment' : 'Retry close',
        'row-action details-action-primary',
        () => void run(withNote),
      );
      const keepField = withNote && !commentPosted;
      return {
        status,
        feedback,
        option: keepField ? composer() : null,
        actions: [retry],
      };
    }

    if (reason) {
      return {
        status,
        feedback,
        option: null,
        actions: lockedActions(reason, ['Close issue', 'Close with a comment']),
      };
    }

    if (phase === 'confirming') {
      const confirm = button(
        ID.confirm,
        'Confirm close issue?',
        'row-action confirm',
        () => void run(false),
      );
      const cancel = button(ID.close, 'Cancel', 'row-action cancel', () =>
        drop(ID.close),
      );
      return { status, feedback, option: null, actions: [confirm, cancel] };
    }

    if (phase === 'composing' || (phase === 'working' && withNote)) {
      const working = phase === 'working';
      const send = button(
        ID.send,
        working ? 'Closing…' : 'Comment and close',
        'row-action details-action-primary',
        () => {
          if (phase === 'composing') void run(true);
        },
      );
      if (working) send.setAttribute('aria-disabled', 'true');
      const cancel = button(ID.comment, 'Cancel', 'row-action cancel', () =>
        drop(ID.comment),
      );
      return {
        status,
        feedback,
        option: composer(),
        actions: working ? [send] : [send, cancel],
      };
    }

    const close = button(ID.close, 'Close issue', 'row-action close', () => {
      failure = null;
      phase = 'confirming';
      draw(ID.confirm);
      host.announce(
        `Confirm close of #${target?.number}? Press Confirm or Cancel.`,
      );
    });
    const withComment = button(
      ID.comment,
      'Close with a comment',
      'row-action',
      () => {
        failure = null;
        phase = 'composing';
        draw(ID.field);
      },
    );
    if (phase === 'working') {
      close.setAttribute('aria-disabled', 'true');
      withComment.setAttribute('aria-disabled', 'true');
    }
    return { status, feedback, option: null, actions: [close, withComment] };
  }

  function draw(focusId = '') {
    host.render(chrome());
    if (focusId) document.getElementById(focusId)?.focus();
  }

  // A comment that was posted belongs to the attempt that is being dropped.
  function forgetAttempt() {
    commentPosted = false;
    withNote = false;
  }

  function drop(focusId: string) {
    phase = 'idle';
    failure = null;
    forgetAttempt();
    text = text.trim() === '' ? '' : text;
    draw(focusId);
  }

  function refused(err: ActionRequestError, half: Retry) {
    if (!target) return;
    const forge = target.forge;
    const outcome = interpretActionFailure(err, (resetsAt) =>
      host.rateLimitReason(forge, resetsAt),
    );
    const state =
      half === 'reopen' ? 'closed' : withNote ? 'composing' : 'idle';
    const reason =
      outcome.kind === 'settled'
        ? outcome.message
        : outcome.kind === 'locked' &&
            err.code === 'permission' &&
            err.fromServer
          ? err.message
          : outcome.reason;
    if (outcome.kind === 'locked') {
      locked = reason;
      phase = state;
      failure =
        half === 'close' && commentPosted
          ? { line: 'Your comment was posted. The issue is still open.' }
          : null;
      host.announce(`Couldn't change the issue: ${reason}`);
      draw();
      return;
    }
    phase = state;
    const prefix =
      half === 'comment'
        ? 'Your comment was not posted. The issue is still open.'
        : commentPosted
          ? 'Your comment was posted. The issue is still open.'
          : half === 'close'
            ? "Couldn't close the issue."
            : "Couldn't reopen the issue.";
    failure = {
      line: `${prefix} ${reason}`,
      retry: half,
    };
    host.announce(failure.line);
    draw(half === 'reopen' ? ID.reopen : ID.retry);
  }

  // The close, with the comment first when one was asked for and is not yet
  // posted. A retry after a posted comment skips it.
  async function run(withComment: boolean) {
    if (!target) return;
    const mine = session;
    withNote = withComment;
    if (withComment && !commentPosted && text.trim() === '') {
      failure = { line: BLANK_COMMENT };
      phase = 'composing';
      draw(ID.field);
      return;
    }
    failure = null;
    phase = 'working';
    draw();
    if (withComment && !commentPosted) {
      try {
        await post('/api/issues/comment', { ...ref(), body: text });
      } catch (e) {
        if (mine === session) refused(e as ActionRequestError, 'comment');
        return;
      }
      commentPosted = true;
    }
    try {
      await post('/api/issues/close', ref());
    } catch (e) {
      if (mine === session) refused(e as ActionRequestError, 'close');
      return;
    }
    if (mine !== session) return;
    commentPosted = false;
    text = '';
    closedAt = Date.now();
    phase = 'closed';
    host.showClosed(true);
    draw(ID.reopen);
    host.announce(`${target.repo}#${target.number}: ${CLOSED_STATUS}`);
    host.refresh();
  }

  async function reopenNow() {
    if (!target) return;
    const mine = session;
    failure = null;
    phase = 'reopening';
    draw();
    try {
      await post('/api/issues/reopen', ref());
    } catch (e) {
      if (mine === session) refused(e as ActionRequestError, 'reopen');
      return;
    }
    if (mine !== session) return;
    closedAt = 0;
    phase = 'idle';
    host.showClosed(false);
    draw(ID.close);
    host.announce(`${target.repo}#${target.number}: Reopened.`);
    host.refresh();
  }

  return {
    // A new dialog on this issue.
    open(next: IssueTarget) {
      session++;
      target = next;
      phase = 'idle';
      text = '';
      commentPosted = false;
      withNote = false;
      closedAt = 0;
      failure = null;
      locked = null;
      draw();
    },
    // The dialog closed: forget it, and let an in-flight request end quietly.
    dispose() {
      session++;
      target = null;
      phase = 'idle';
    },
    // Escape ends a confirm or the comment field before it closes the dialog.
    escape(): boolean {
      if (phase === 'confirming') {
        drop(ID.close);
        return true;
      }
      if (phase === 'composing') {
        text = '';
        drop(ID.comment);
        return true;
      }
      return false;
    },
    // What the dialog's own read of the forge says. Returns whether the header
    // should follow it: an "open" right after our own close is not believed.
    forgeState(closed: boolean): boolean {
      if (!target) return true;
      if (closed) {
        if (
          phase === 'idle' ||
          phase === 'confirming' ||
          phase === 'composing'
        ) {
          phase = 'closed';
          failure = null;
          text = '';
          forgetAttempt();
          draw();
        }
        return true;
      }
      if (phase === 'closed' || phase === 'reopening') {
        if (Date.now() - closedAt < SETTLE_MS) return false;
        phase = 'idle';
        draw();
      }
      return true;
    },
  };
}
