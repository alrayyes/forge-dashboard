import { expect, type Locator } from '@playwright/test';

// Opens a pull request row's details dialog and returns it, the scope a spec
// searches for the row's actions in. The row's title button opens it (#1690);
// specs that once opened More actions use this instead (#943).
//
// The title button's name starts with "#<number> ", matched at the start so
// "#4 " never picks "#42 ". Pass the number to say which one when a row is
// not unique on its own.
export async function openActionsDialog(
  row: Locator,
  number?: number,
): Promise<Locator> {
  const page = row.page();
  const prefix = number === undefined ? '\\d+' : String(number);
  await row.getByRole('button', { name: new RegExp(`^#${prefix} `) }).click();
  const dialog = page.getByRole('dialog', { name: /^Pull request details/ });
  await expect(dialog).toBeVisible();
  return dialog;
}

// The dialog's footer: the actions the row offers, primary first and Close
// last. Specs look for an action by role and name in here, never in the row.
export function actionsFooter(dialog: Locator): Locator {
  return dialog.locator('.details-footer');
}

// The failure lines the dialog shows above its footer.
export function actionsFeedback(dialog: Locator): Locator {
  return dialog.locator('.details-feedback');
}

// Closes the dialog from its header and waits for it to be gone, so the row
// behind it can be asserted on and clicked again. A dialog the action already
// closed (Hide, a pull request that left the board, a merge) is left alone. A
// merge can close it between the visibility check and the click (#1927), so the
// click ignores a button that vanished: a closed dialog is the goal either way.
export async function closeActionsDialog(dialog: Locator): Promise<void> {
  // The dialog can rebuild under the click (a held refresh, a refetch), which
  // drops that click, so ask again until it is gone.
  await expect(async () => {
    if (!(await dialog.isVisible())) return;
    await dialog
      .getByRole('button', { name: 'Close details' })
      .click({ force: true, timeout: 1_000 })
      .catch(() => {});
    await expect(dialog).toBeHidden({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
}

// Opens the row's dialog, runs `act` against its footer (the actions) and the
// dialog itself, and closes it again. For a spec that starts an action here
// and then asserts on the row behind, which a modal dialog covers while it is
// open.
export async function viaActionsDialog(
  row: Locator,
  act: (footer: Locator, dialog: Locator) => Promise<void>,
  number?: number,
): Promise<void> {
  const dialog = await openActionsDialog(row, number);
  await act(actionsFooter(dialog), dialog);
  await closeActionsDialog(dialog);
}
