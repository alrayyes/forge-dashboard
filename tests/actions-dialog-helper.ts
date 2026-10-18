import { expect, type Locator } from '@playwright/test';

// Opens a pull request row's details dialog and returns it, the scope a spec
// searches for the row's actions in. The row's title button opens it (#1690);
// specs that once opened More actions use this instead (#943).
//
// The dialog holds an "Open on <forge>" link today and the actions follow in
// later changes, so a spec asks the returned locator for them by role and
// name, and this helper needs no change when they land.
export async function openActionsDialog(row: Locator): Promise<Locator> {
  const page = row.page();
  await row.getByRole('button', { name: /^#\d+ / }).click();
  const dialog = page.getByRole('dialog', { name: /^Pull request details/ });
  await expect(dialog).toBeVisible();
  return dialog;
}
